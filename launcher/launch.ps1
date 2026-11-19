# Glasswave launcher
# Hands the app's files to your browser from your own computer only (127.0.0.1),
# opens the player window, and switches itself off after it has not been needed
# for a few minutes. The player keeps working after that from its saved copy.
#
# It also does two small jobs for the player while it is running:
#   - lists and plays the music files in your Music folder (Local Files)
#   - asks the public lyrics site lrclib.net for lyrics when the player cannot ask it directly
param(
  [int]$Port = 8765,
  [int]$IdleSeconds = 600,
  [int]$ParentPid = 0,
  [switch]$NoBrowser,
  [string]$MusicDir = '',
  [string]$LyricsBase = 'https://lrclib.net'
)
$ErrorActionPreference = 'Stop'
$home0 = Split-Path -Parent $PSScriptRoot
$root = [IO.Path]::GetFullPath((Join-Path $home0 'app'))
$url = "http://127.0.0.1:$Port/"
# The player has to show this pass before it is given any music file or lyrics.
$token = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')

function Find-InstalledApp {
  # If Glasswave was installed as an app from the browser, that install has its own
  # shortcut. Opening it gives the window whose top bar follows the app's colours.
  try {
    $shell = New-Object -ComObject WScript.Shell
    $places = @((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'), [Environment]::GetFolderPath('Desktop'))
    foreach ($place in $places) {
      if (-not $place -or -not (Test-Path -LiteralPath $place)) { continue }
      $links = Get-ChildItem -LiteralPath $place -Filter 'Glasswave*.lnk' -Recurse -ErrorAction SilentlyContinue
      foreach ($link in $links) {
        $target = $shell.CreateShortcut($link.FullName)
        if ($target.Arguments -match '--app-id=' -and $target.TargetPath -match '(chrome|msedge|brave|vivaldi)(_proxy)?\.exe$') { return $link.FullName }
      }
    }
  } catch { }
  return $null
}

function Open-Player {
  if ($NoBrowser) { return }
  $installed = Find-InstalledApp
  if ($installed) {
    try { Start-Process -FilePath $installed; return } catch { }
  }
  # Otherwise open in an app-style window when the default browser supports it, or as a normal tab.
  try {
    $exe = $null
    $progId = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice' -ErrorAction Stop).ProgId
    if ($progId) {
      $cmd = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\$progId\shell\open\command" -ErrorAction Stop).'(default)'
      if ($cmd -match '^\s*"([^"]+\.exe)"' -or $cmd -match '^\s*(\S+\.exe)') { $exe = $Matches[1] }
    }
    if ($exe -and (Test-Path -LiteralPath $exe) -and ([IO.Path]::GetFileName($exe) -match '^(chrome|msedge|brave|vivaldi)\.exe$')) {
      Start-Process -FilePath $exe -ArgumentList "--app=$url"
      return
    }
  } catch { }
  try { Start-Process $url } catch { }
}

function Send-Reply($stream, [int]$code, [string]$status, [string]$type, $body, [string]$extra) {
  $len = 0
  if ($body) { $len = $body.Length }
  $head = "HTTP/1.1 $code $status`r`nContent-Type: $type`r`nContent-Length: $len`r`nCache-Control: no-cache`r`nX-Content-Type-Options: nosniff`r`n${extra}Connection: close`r`n`r`n"
  $bytes = [Text.Encoding]::ASCII.GetBytes($head)
  $stream.Write($bytes, 0, $bytes.Length)
  if ($len -gt 0) { $stream.Write($body, 0, $len) }
  $stream.Flush()
}
function Send-Json($stream, [int]$code, [string]$status, [string]$json) {
  Send-Reply $stream $code $status 'application/json' ([Text.Encoding]::UTF8.GetBytes($json)) ''
}

$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.png' = 'image/png'; '.ico' = 'image/x-icon'; '.svg' = 'image/svg+xml'
  '.json' = 'application/json'; '.webmanifest' = 'application/manifest+json'
}
$sep = [IO.Path]::DirectorySeparatorChar

# ---- Local Files ---------------------------------------------------------------------
# Kinds of music file the player can play.
$audio = @{
  '.mp3' = 'audio/mpeg'; '.m4a' = 'audio/mp4'; '.aac' = 'audio/aac'; '.flac' = 'audio/flac'
  '.wav' = 'audio/wav'; '.ogg' = 'audio/ogg'; '.oga' = 'audio/ogg'; '.opus' = 'audio/ogg'
}
$maxFiles = 8000
$maxPiece = 4194304
$musicRoots = $null
$jsonUnsafe = New-Object System.Text.RegularExpressions.Regex('[^\x20\x21\x23-\x5b\x5d-\x7e]')
$jsonEscape = [System.Text.RegularExpressions.MatchEvaluator] { param($m) '\u' + ([int][char]$m.Value).ToString('x4') }
function Json-Text([string]$s) { return '"' + $jsonUnsafe.Replace($s, $jsonEscape) + '"' }

function Clean-Dir([string]$p) {
  $full = [IO.Path]::GetFullPath($p)
  if ($full.Length -gt 3) { $full = $full.TrimEnd('\', '/') }
  return $full
}
function Get-MusicRoots {
  # Your Music folder, plus any folders listed in "Local folders.txt" (one per line).
  $list = New-Object System.Collections.ArrayList
  $wanted = New-Object System.Collections.ArrayList
  $first = $MusicDir
  if (-not $first) { try { $first = [Environment]::GetFolderPath('MyMusic') } catch { $first = '' } }
  if ($first) { [void]$wanted.Add($first) }
  $extra = Join-Path $home0 'Local folders.txt'
  try {
    if (Test-Path -LiteralPath $extra -PathType Leaf) {
      foreach ($line in [IO.File]::ReadAllLines($extra)) {
        $p = $line.Trim().Trim('"')
        if ($p -ne '' -and -not $p.StartsWith('#')) { [void]$wanted.Add($p) }
      }
    }
  } catch { }
  foreach ($p in $wanted) {
    try {
      $full = Clean-Dir $p
      if (-not (Test-Path -LiteralPath $full -PathType Container)) { continue }
      $inside = $false
      foreach ($have in $list) {
        if ($full.Equals($have, [StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($have.TrimEnd('\', '/') + $sep, [StringComparison]::OrdinalIgnoreCase)) { $inside = $true }
      }
      if (-not $inside) { [void]$list.Add($full) }
    } catch { }
  }
  $script:musicRoots = $list
}
function Get-MusicList {
  Get-MusicRoots
  $epoch = New-Object DateTime(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
  $skip = [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System -bor [IO.FileAttributes]::ReparsePoint
  $sb = New-Object System.Text.StringBuilder
  $count = 0
  for ($ri = 0; $ri -lt $musicRoots.Count; $ri++) {
    $base = $musicRoots[$ri]
    $stack = New-Object System.Collections.Stack
    $stack.Push(@($base, 0))
    while ($stack.Count -gt 0 -and $count -lt $maxFiles) {
      $item = $stack.Pop()
      try {
        $info = New-Object System.IO.DirectoryInfo($item[0])
        foreach ($f in $info.GetFiles()) {
          if ($count -ge $maxFiles) { break }
          if (-not $audio.ContainsKey($f.Extension.ToLowerInvariant())) { continue }
          $rel = $f.FullName.Substring($base.Length).TrimStart('\', '/').Replace('\', '/')
          $when = [int64]($f.LastWriteTimeUtc - $epoch).TotalSeconds
          if ($count -gt 0) { [void]$sb.Append(',') }
          [void]$sb.Append('[').Append($ri).Append(',').Append((Json-Text $rel)).Append(',').Append($f.Length).Append(',').Append($when).Append(']')
          $count++
        }
        if ($item[1] -lt 8) {
          foreach ($d in $info.GetDirectories()) {
            if (($d.Attributes -band $skip) -ne 0) { continue }
            $stack.Push(@($d.FullName, ($item[1] + 1)))
          }
        }
      } catch { }
    }
  }
  $names = @()
  foreach ($r in $musicRoots) { $names += (Json-Text $r) }
  $full = 'false'
  if ($count -ge $maxFiles) { $full = 'true' }
  return '{"roots":[' + ($names -join ',') + '],"more":' + $full + ',"files":[' + $sb.ToString() + ']}'
}

# Sends (part of) one music file. The sending carries on by itself in the background,
# so one long song never holds up anything else.
function Send-Music($client, $stream, [string]$method, $query, $headers) {
  if ($null -eq $musicRoots) { Get-MusicRoots }
  $ri = -1
  if (-not [int]::TryParse([string]$query['r'], [ref]$ri) -or $ri -lt 0 -or $ri -ge $musicRoots.Count) { Send-Reply $stream 404 'Not Found' 'text/plain' $null ''; return }
  $rel = [string]$query['p']
  if ($rel -eq '' -or $rel -match '(^|[\\/])\.\.([\\/]|$)' -or $rel -match ':') { Send-Reply $stream 404 'Not Found' 'text/plain' $null ''; return }
  $base = $musicRoots[$ri]
  $full = [IO.Path]::GetFullPath((Join-Path $base $rel))
  $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
  if (-not $full.StartsWith($base.TrimEnd('\', '/') + $sep, [StringComparison]::OrdinalIgnoreCase) -or -not $audio.ContainsKey($ext) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
    Send-Reply $stream 404 'Not Found' 'text/plain' $null ''
    return
  }
  $fs = [IO.File]::Open($full, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  $handed = $false
  try {
    $len = $fs.Length
    $start = [int64]0
    $end = $len - 1
    $partial = $false
    $range = [string]$headers['range']
    if ($range -match '^bytes=(\d*)-(\d*)$') {
      $a = $Matches[1]; $b = $Matches[2]
      if ($a -ne '') {
        $start = [int64]$a
        if ($b -ne '') { $end = [Math]::Min([int64]$b, $len - 1) }
        $partial = $true
      } elseif ($b -ne '') {
        $start = [Math]::Max([int64]0, $len - [int64]$b)
        $partial = $true
      }
    }
    if ($partial -and ($start -ge $len -or $end -lt $start)) {
      Send-Reply $stream 416 'Range Not Satisfiable' 'text/plain' $null "Content-Range: bytes */$len`r`n"
      return
    }
    $toEnd = ($end -eq $len - 1)
    if (-not $toEnd -and ($end - $start + 1) -gt $maxPiece) { $end = $start + $maxPiece - 1 }
    $count = $end - $start + 1
    $line = 'HTTP/1.1 200 OK'
    $extra = ''
    if ($partial) { $line = 'HTTP/1.1 206 Partial Content'; $extra = "Content-Range: bytes $start-$end/$len`r`n" }
    $head = "$line`r`nContent-Type: $($audio[$ext])`r`nContent-Length: $count`r`nAccept-Ranges: bytes`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`n${extra}Connection: close`r`n`r`n"
    $bytes = [Text.Encoding]::ASCII.GetBytes($head)
    $stream.Write($bytes, 0, $bytes.Length)
    if ($method -eq 'HEAD' -or $count -le 0) { $stream.Flush(); return }
    $fs.Position = $start
    if ($toEnd) {
      $task = $fs.CopyToAsync($stream, 65536)
      [void]$streams.Add(@{ kind = 'file'; task = $task; client = $client; fs = $fs; t = [DateTime]::UtcNow })
    } else {
      $piece = New-Object byte[] $count
      $got = 0
      while ($got -lt $count) {
        $r = $fs.Read($piece, $got, $count - $got)
        if ($r -le 0) { break }
        $got += $r
      }
      $task = $stream.WriteAsync($piece, 0, $got)
      [void]$streams.Add(@{ kind = 'file'; task = $task; client = $client; fs = $null; t = [DateTime]::UtcNow })
      $fs.Dispose()
    }
    $handed = $true
    $script:handedOff = $true
  } finally {
    if (-not $handed) { try { $fs.Dispose() } catch { } }
  }
}

# ---- Lyrics ----------------------------------------------------------------------------
# Only the song's title, artist, album and length are sent, to lrclib.net. Nothing about you.
$http = $null
function Start-Lyrics($client, $stream, $query) {
  if ($null -eq $script:http) {
    Add-Type -AssemblyName System.Net.Http
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    $script:http = New-Object System.Net.Http.HttpClient
    $script:http.Timeout = [TimeSpan]::FromSeconds(10)
    [void]$script:http.DefaultRequestHeaders.TryAddWithoutValidation('User-Agent', 'Glasswave/1.1 (personal music player)')
  }
  $kind = 'get'
  if ([string]$query['kind'] -eq 'search') { $kind = 'search' }
  $pairs = @()
  foreach ($name in @('track_name', 'artist_name', 'album_name', 'duration')) {
    $value = [string]$query[$name]
    if ($value -ne '') { $pairs += ($name + '=' + [Uri]::EscapeDataString($value)) }
  }
  if ($pairs.Count -eq 0) { Send-Json $stream 400 'Bad Request' '{"error":"nothing to look up"}'; return }
  $target = $LyricsBase.TrimEnd('/') + '/api/' + $kind + '?' + ($pairs -join '&')
  $task = $script:http.GetAsync($target)
  [void]$streams.Add(@{ kind = 'http'; task = $task; client = $client; stream = $stream; t = [DateTime]::UtcNow })
  $script:handedOff = $true
}
function Finish-Lyrics($entry) {
  try {
    if ($entry.task.Status -eq [System.Threading.Tasks.TaskStatus]::RanToCompletion) {
      $resp = $entry.task.Result
      $code = [int]$resp.StatusCode
      if ($code -eq 200) {
        Send-Reply $entry.stream 200 'OK' 'application/json' ($resp.Content.ReadAsByteArrayAsync().Result) ''
      } elseif ($code -eq 404) {
        Send-Json $entry.stream 404 'Not Found' '{"name":"TrackNotFound"}'
      } else {
        Send-Json $entry.stream 502 'Bad Gateway' ('{"error":"lyrics site answered ' + $code + '"}')
      }
      try { $resp.Dispose() } catch { }
    } else {
      Send-Json $entry.stream 502 'Bad Gateway' '{"error":"lyrics site could not be reached"}'
    }
  } catch { }
}
function Close-Entry($entry) {
  try { $entry.client.Client.Shutdown([System.Net.Sockets.SocketShutdown]::Send) } catch { }
  try { $entry.client.Close() } catch { }
  if ($entry.fs) { try { $entry.fs.Dispose() } catch { } }
}

# The player's own requests to this helper (addresses that start with /__).
function Handle-Helper($client, $stream, [string]$method, [string]$path, $query, $headers) {
  # Only the player itself may ask: not another website open in the browser.
  $site = [string]$headers['sec-fetch-site']
  if ($site -ne '' -and $site -ne 'same-origin' -and $site -ne 'none') { Send-Reply $stream 403 'Forbidden' 'text/plain' $null ''; return }
  if ($path -eq '__local/token') { Send-Json $stream 200 'OK' ('{"token":"' + $token + '","version":2}'); return }
  if ([string]$query['t'] -cne $token) { Send-Json $stream 403 'Forbidden' '{"error":"pass"}'; return }
  if ($path -eq '__local/list') { Send-Json $stream 200 'OK' (Get-MusicList); return }
  if ($path -eq '__local/file') { Send-Music $client $stream $method $query $headers; return }
  if ($path -eq '__lyrics') { Start-Lyrics $client $stream $query; return }
  Send-Reply $stream 404 'Not Found' 'text/plain' $null ''
}

$handedOff = $false
function Handle-Client($client) {
  $script:handedOff = $false
  try {
    $client.ReceiveTimeout = 2000
    $client.SendTimeout = 5000
    $stream = $client.GetStream()
    $buf = New-Object byte[] 16384
    $n = 0
    $text = ''
    while ($n -lt $buf.Length) {
      $r = $stream.Read($buf, $n, $buf.Length - $n)
      if ($r -le 0) { break }
      $n += $r
      $text = [Text.Encoding]::ASCII.GetString($buf, 0, $n)
      if ($text.Contains("`r`n`r`n")) { break }
    }
    $lines = $text -split "`r`n"
    $parts = $lines[0] -split ' '
    if ($parts.Length -lt 2 -or ($parts[0] -ne 'GET' -and $parts[0] -ne 'HEAD')) {
      Send-Reply $stream 405 'Method Not Allowed' 'text/plain' $null ''
      return
    }
    $headers = @{}
    for ($i = 1; $i -lt $lines.Length; $i++) {
      if ($lines[$i] -eq '') { break }
      $colon = $lines[$i].IndexOf(':')
      if ($colon -gt 0) { $headers[$lines[$i].Substring(0, $colon).Trim().ToLowerInvariant()] = $lines[$i].Substring($colon + 1).Trim() }
    }
    # Only answer when the browser is really asking for this computer's own address.
    $hostName = ([string]$headers['host']).ToLowerInvariant()
    if ($hostName -eq "localhost:$Port") {
      Send-Reply $stream 302 'Found' 'text/plain' $null "Location: $url`r`n"
      return
    }
    if ($hostName -ne "127.0.0.1:$Port") {
      Send-Reply $stream 403 'Forbidden' 'text/plain' $null ''
      return
    }
    $pieces = $parts[1] -split '\?', 2
    $path = [Uri]::UnescapeDataString($pieces[0]).TrimStart('/')
    if ($path.StartsWith('__')) {
      $query = @{}
      if ($pieces.Length -gt 1) {
        foreach ($pair in ($pieces[1] -split '&')) {
          if ($pair -eq '') { continue }
          $kv = $pair -split '=', 2
          $value = ''
          if ($kv.Length -gt 1) { $value = [Uri]::UnescapeDataString($kv[1].Replace('+', ' ')) }
          $query[[Uri]::UnescapeDataString($kv[0])] = $value
        }
      }
      Handle-Helper $client $stream $parts[0] $path $query $headers
      return
    }
    $file = $null
    if ($path -ne '' -and $path -notmatch '\.\.' -and $path -notmatch '[:\\]') {
      $candidate = [IO.Path]::GetFullPath((Join-Path $root $path))
      if ($candidate.StartsWith($root + $sep, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $file = $candidate }
    }
    if (-not $file) {
      if ([IO.Path]::GetExtension($path) -ne '') {
        Send-Reply $stream 404 'Not Found' 'text/plain' $null ''
        return
      }
      # "/", "/callback" and any other page address all load the app itself.
      $file = Join-Path $root 'index.html'
    }
    $body = [IO.File]::ReadAllBytes($file)
    $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
    $type = 'application/octet-stream'
    if ($types.ContainsKey($ext)) { $type = $types[$ext] }
    if ($parts[0] -eq 'HEAD') { $body = $null }
    Send-Reply $stream 200 'OK' $type $body ''
  } catch {
  } finally {
    if (-not $script:handedOff) {
      try { $client.Client.Shutdown([System.Net.Sockets.SocketShutdown]::Send) } catch { }
      try { $client.Close() } catch { }
    }
  }
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
try {
  $listener.Start()
} catch {
  # Already running from an earlier launch: just bring up the window.
  Open-Player
  exit 0
}
Open-Player

$waiting = New-Object System.Collections.ArrayList
$streams = New-Object System.Collections.ArrayList     # songs and lyrics still on their way
$last = [DateTime]::UtcNow
try {
  while ($true) {
    $wait = 5000000
    if ($waiting.Count -gt 0) { $wait = 15000 } elseif ($streams.Count -gt 0) { $wait = 150000 }
    if ($listener.Server.Poll($wait, [System.Net.Sockets.SelectMode]::SelectRead)) {
      while ($listener.Pending()) {
        [void]$waiting.Add(@{ c = $listener.AcceptTcpClient(); t = [DateTime]::UtcNow })
      }
    }
    for ($i = $waiting.Count - 1; $i -ge 0; $i--) {
      $entry = $waiting[$i]
      $ready = $false
      try { $ready = ($entry.c.Available -gt 0) } catch { $ready = $false }
      if ($ready) {
        $waiting.RemoveAt($i)
        Handle-Client $entry.c
        $last = [DateTime]::UtcNow
      } elseif (([DateTime]::UtcNow - $entry.t).TotalSeconds -gt 4) {
        $waiting.RemoveAt($i)
        try { $entry.c.Close() } catch { }
      }
    }
    for ($i = $streams.Count - 1; $i -ge 0; $i--) {
      $entry = $streams[$i]
      $age = ([DateTime]::UtcNow - $entry.t).TotalSeconds
      if ($entry.task.IsCompleted -or $age -gt 900) {
        $streams.RemoveAt($i)
        if ($entry.kind -eq 'http' -and $entry.task.IsCompleted) { Finish-Lyrics $entry }
        Close-Entry $entry
        $last = [DateTime]::UtcNow
      }
    }
    if ($ParentPid -gt 0) {
      # Started by the standalone window: stay for as long as that window is open.
      if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    } elseif ($waiting.Count -eq 0 -and $streams.Count -eq 0 -and ([DateTime]::UtcNow - $last).TotalSeconds -ge $IdleSeconds) { break }
  }
} finally {
  foreach ($entry in $streams) { Close-Entry $entry }
  try { $listener.Stop() } catch { }
}
