interface ReaderEditScheduler {
  readonly frame: (run: () => void) => () => void;
  readonly task: (run: () => void) => () => void;
}

interface ReaderEditSessionOptions {
  readonly sourceText: string;
  readonly readText: () => string | null;
  readonly isFocused: () => boolean;
  readonly restoreChildren: () => void;
  readonly onCommit: (text: string) => Promise<boolean>;
  readonly onDraftChange: (dirty: boolean) => void;
  readonly onCommittingChange: (active: boolean) => void;
  readonly onRestricted: (reason: string, draftText?: string) => void;
  readonly scheduler: ReaderEditScheduler;
}

/** Owns one rendered source block's native edit lifecycle, never its source mapping. */
export function createReaderEditSession(options: ReaderEditSessionOptions) {
  let alive = true;
  let editing = false;
  let composing = false;
  let settling = false;
  let pendingBlur = false;
  let generation = 0;
  let draft = options.sourceText;
  let cancelScheduled: (() => void) | null = null;
  let releaseSettlingActivity: (() => void) | null = null;

  const acquireSettlingActivity = () => {
    if (releaseSettlingActivity) return releaseSettlingActivity;
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      if (releaseSettlingActivity === release) releaseSettlingActivity = null;
      options.onCommittingChange(false);
    };
    releaseSettlingActivity = release;
    options.onCommittingChange(true);
    return release;
  };
  const cancel = () => {
    generation++;
    cancelScheduled?.();
    cancelScheduled = null;
    settling = false;
    pendingBlur = false;
    composing = false;
    editing = false;
    releaseSettlingActivity?.();
  };
  const restoreChildren = () => {
    if (!alive) return;
    cancel();
    draft = options.sourceText;
    options.restoreChildren();
  };
  const restore = () => {
    if (!alive) return;
    options.onDraftChange(false);
    restoreChildren();
  };
  const readDraft = () => {
    const text = options.readText();
    if (text === null) { cancel(); return false; }
    if (/\r|\n/u.test(text)) {
      options.onRestricted('换行请在源码中继续，已保留未应用的输入。', text);
      restore();
      return false;
    }
    draft = text;
    options.onDraftChange(text !== options.sourceText);
    return true;
  };
  const commit = () => {
    if (!alive || !editing) return;
    const release = acquireSettlingActivity();
    if (!readDraft()) return;
    // The emitted mutation cannot be cancelled by a later focus or unmount.
    // Transfer this lease to this promise until its own finally, with no gap
    // between settling the native text and handing it to the source owner.
    releaseSettlingActivity = null;
    editing = false;
    pendingBlur = false;
    settling = false;
    const token = ++generation;
    const next = draft;
    options.onDraftChange(false);
    if (next === options.sourceText) { release(); return; }
    const current = () => alive && token === generation && !composing && !options.isFocused();
    const rejected = (reason: string) => {
      if (!current()) return;
      options.onRestricted(reason, next);
      if (current()) restoreChildren();
    };
    // Invoke immediately on an ordinary blur: Ctrl+S relies on this synchronous
    // handoff. Only composition completion needs the frame/task settling window.
    try {
      void options.onCommit(next).then(accepted => {
        if (!current()) return;
        if (!accepted) options.onRestricted('正文输入尚未应用，请在源码中继续。', next);
        // Draft ownership was handed off above. A different block may now
        // own the app's draft flag, so completion only restores these children.
        if (current()) restoreChildren();
      }, () => rejected('正文输入尚未应用，请保留输入并重试。')).finally(release);
    } catch {
      try { rejected('正文输入尚未应用，请保留输入并重试。'); }
      finally { release(); }
    }
  };
  const scheduleFinish = () => {
    cancelScheduled?.();
    const token = ++generation;
    const current = () => alive && settling && !composing && token === generation;
    // Native final input can follow compositionend. Wait through a frame and
    // its following task, then read the live DOM rather than an event snapshot.
    cancelScheduled = options.scheduler.frame(() => {
      if (!current()) return;
      cancelScheduled = options.scheduler.task(() => {
        if (!current()) return;
        cancelScheduled = null;
        if (!readDraft() || !current()) return;
        settling = false;
        if (pendingBlur && !options.isFocused()) commit();
        else {
          pendingBlur = false;
          releaseSettlingActivity?.();
        }
      });
    });
  };

  return {
    composing: () => composing,
    ownsDraft: () => editing,
    focus: () => {
      if (!alive) return;
      cancel();
      editing = true;
    },
    compositionStart: () => {
      if (!alive) return;
      cancel();
      editing = true;
      composing = true;
    },
    compositionEnd: () => {
      if (!alive || !composing) return;
      composing = false;
      settling = true;
      acquireSettlingActivity();
      scheduleFinish();
    },
    input: () => {
      if (!alive || !readDraft()) return;
      if (settling) scheduleFinish();
    },
    blur: () => {
      if (!alive || !editing) return;
      if (composing || settling) pendingBlur = true;
      else commit();
    },
    restore,
    dispose: () => {
      if (!alive) return;
      alive = false;
      cancel();
    },
  };
}
