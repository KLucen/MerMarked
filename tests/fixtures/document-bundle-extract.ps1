param(
  [Parameter(Mandatory=$true)][string]$Archive,
  [Parameter(Mandatory=$true)][string]$Destination
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archivePath=[IO.Path]::GetFullPath($Archive)
$destinationPath=[IO.Path]::GetFullPath($Destination)
$temporaryPath=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
$prefix=$temporaryPath+[IO.Path]::DirectorySeparatorChar
if(!$destinationPath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Extraction destination must be temporary'}
$relative=$destinationPath.Substring($prefix.Length)
if(($relative -split '[\\/]')[0] -notlike 'mermarkd-file1c-*'){throw 'Unexpected extraction workspace'}
$destinationItem=Get-Item -LiteralPath $destinationPath
if(!$destinationItem.PSIsContainer -or ($destinationItem.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Destination must be a real directory'}
if(@(Get-ChildItem -LiteralPath $destinationPath -Force).Count){throw 'Destination must be empty'}
$archiveItem=Get-Item -LiteralPath $archivePath
if($archiveItem.PSIsContainer -or ($archiveItem.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Archive must be a regular file'}
$destinationPrefix=$destinationPath.TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar
$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$plan=@();$totalBytes=0L
$zip=[IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  if($zip.Entries.Count -gt 128){throw 'Unexpected entry count'}
  foreach($entry in $zip.Entries){
    $name=$entry.FullName
    if(!$name -or $name.Contains('\') -or [IO.Path]::IsPathRooted($name) -or $name -match '^[a-zA-Z]:'){throw 'Entry path must be relative POSIX'}
    $directory=$name.EndsWith('/')
    $trimmed=$name.TrimEnd('/')
    $segments=$trimmed.Split('/')
    foreach($segment in $segments){
      if(!$segment -or $segment -eq '.' -or $segment -eq '..' -or $segment -match '[<>:"|?*\x00-\x1f\x7f]' -or $segment -match '[ .]$' -or $segment -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)'){throw 'Unsafe entry segment'}
    }
    if((($entry.ExternalAttributes -shr 16) -band 0xf000) -eq 0xa000){throw 'Symbolic link entry refused'}
    if(!$seen.Add($trimmed.Normalize([Text.NormalizationForm]::FormC))){throw 'Duplicate extraction path'}
    $target=[IO.Path]::GetFullPath((Join-Path $destinationPath ($trimmed.Replace('/',[IO.Path]::DirectorySeparatorChar))))
    if(!$target.StartsWith($destinationPrefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Entry escapes extraction root'}
    $totalBytes+=$entry.Length
    if($entry.Length -gt 50MB -or $totalBytes -gt 60MB){throw 'Unexpected extracted size'}
    $plan+=@([pscustomobject]@{entry=$entry;name=$name;target=$target;directory=$directory})
  }
  foreach($item in $plan){
    $parent=if($item.directory){$item.target}else{[IO.Path]::GetDirectoryName($item.target)}
    $walk=$destinationPath
    $parentRelative=$parent.Substring($destinationPath.Length).TrimStart('\','/')
    if($parentRelative){foreach($segment in ($parentRelative -split '[\\/]')){
      $walk=Join-Path $walk $segment
      if(Test-Path -LiteralPath $walk){$info=Get-Item -LiteralPath $walk;if(!$info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe parent directory'}}
      else{[IO.Directory]::CreateDirectory($walk)|Out-Null}
    }}
    if(!$item.directory){[IO.Compression.ZipFileExtensions]::ExtractToFile($item.entry,$item.target,$false)}
  }
  [pscustomobject]@{decoder='System.IO.Compression.ZipFile';files=@($plan|Where-Object {!$_.directory}|ForEach-Object {$_.name});totalBytes=$totalBytes}|ConvertTo-Json -Compress -Depth 3
} finally {$zip.Dispose()}
