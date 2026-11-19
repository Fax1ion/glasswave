// Glasswave's file helper, running inside Glasswave.exe.
//
// It does the same jobs as launch.ps1 (which the browser version still uses), without a
// second program running alongside the window:
//   - hands the app's files to the window, from this computer only (127.0.0.1)
//   - lists and plays the music files in your Music folder (Local Files)
//   - asks the public lyrics site lrclib.net for lyrics when the page cannot ask it directly
//
// Written for the C# compiler that comes with Windows (C# 5, .NET Framework 4.5 or later).

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace Glasswave
{
    public static class Helper
    {
        // Normally your Music folder and lrclib.net. Can be changed before Start (used for testing).
        public static string MusicDir = null;
        public static string LyricsBase = "https://lrclib.net";

        private const int MaxFiles = 8000;
        private static int port;
        private static string home, appRoot, logFile, url, token;
        private static TcpListener listener;
        private static volatile bool running;
        private static Timer retry;
        private static readonly object gate = new object();
        private static List<string> musicRoots;
        private static HttpClient http;
        private static readonly char[] Seps = new char[] { '\\', '/' };
        private static readonly char Sep = Path.DirectorySeparatorChar;
        private static readonly Regex DotDot = new Regex(@"(^|[\\/])\.\.([\\/]|$)");
        private static readonly Regex RangeHeader = new Regex(@"^bytes=(\d*)-(\d*)$");

        private static readonly Dictionary<string, string> Types = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { ".html", "text/html; charset=utf-8" }, { ".js", "text/javascript; charset=utf-8" }, { ".css", "text/css; charset=utf-8" },
            { ".png", "image/png" }, { ".ico", "image/x-icon" }, { ".svg", "image/svg+xml" },
            { ".json", "application/json" }, { ".webmanifest", "application/manifest+json" }
        };

        // Kinds of music file the player can play.
        private static readonly Dictionary<string, string> Audio = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { ".mp3", "audio/mpeg" }, { ".m4a", "audio/mp4" }, { ".aac", "audio/aac" }, { ".flac", "audio/flac" },
            { ".wav", "audio/wav" }, { ".ogg", "audio/ogg" }, { ".oga", "audio/ogg" }, { ".opus", "audio/ogg" }
        };

        // ---- starting and stopping ------------------------------------------------------------
        // Gives "listening", "shared" (another Glasswave helper already answers there; this one
        // takes over when it stops) or "busy" (some other program has the address).
        public static string Start(int listenPort, string folder, string log)
        {
            port = listenPort;
            home = Path.GetFullPath(folder);
            appRoot = Path.GetFullPath(Path.Combine(home, "app"));
            logFile = log;
            url = "http://127.0.0.1:" + port + "/";
            // The player has to show this pass before it is given any music file or lyrics.
            token = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
            running = true;
            lock (gate)
            {
                if (TryListen()) { Log("File helper started."); return "listening"; }
            }
            if (AnotherGlasswave())
            {
                Log("Another Glasswave helper already answers on port " + port + "; using it, and taking over when it stops.");
                retry = new Timer(Retry, null, 10000, 10000);
                return "shared";
            }
            Log("Port " + port + " is in use by another program.");
            return "busy";
        }

        public static void Stop()
        {
            running = false;
            lock (gate)
            {
                if (retry != null) { try { retry.Dispose(); } catch { } retry = null; }
                if (listener != null) { try { listener.Stop(); } catch { } listener = null; }
            }
        }

        private static void Retry(object state)
        {
            lock (gate)
            {
                if (!running || listener != null) return;
                if (TryListen())
                {
                    Log("File helper took over.");
                    if (retry != null) { try { retry.Dispose(); } catch { } retry = null; }
                }
            }
        }

        private static bool TryListen()
        {
            TcpListener next = new TcpListener(IPAddress.Loopback, port);
            try { next.Start(64); }
            catch (SocketException) { try { next.Stop(); } catch { } return false; }
            listener = next;
            Thread loop = new Thread(AcceptLoop);
            loop.IsBackground = true;
            loop.Name = "Glasswave helper";
            loop.Start(next);
            return true;
        }

        private static void AcceptLoop(object state)
        {
            TcpListener mine = (TcpListener)state;
            int failures = 0;
            while (running)
            {
                TcpClient client;
                try { client = mine.AcceptTcpClient(); failures = 0; }
                catch
                {
                    if (!running) return;
                    if (++failures > 50)
                    {
                        Log("File helper stopped accepting; it will try to listen again.");
                        lock (gate)
                        {
                            if (listener == mine) { try { mine.Stop(); } catch { } listener = null; }
                            if (retry == null && running) retry = new Timer(Retry, null, 2000, 10000);
                        }
                        return;
                    }
                    Thread.Sleep(50);
                    continue;
                }
                Thread worker = new Thread(Serve);
                worker.IsBackground = true;
                worker.Start(client);
            }
        }

        // Is the thing on our address a Glasswave helper (for example the browser version's)?
        private static bool AnotherGlasswave()
        {
            try
            {
                using (TcpClient c = new TcpClient())
                {
                    IAsyncResult wait = c.BeginConnect(IPAddress.Loopback, port, null, null);
                    if (!wait.AsyncWaitHandle.WaitOne(2000) || !c.Connected) return false;
                    c.EndConnect(wait);
                    c.ReceiveTimeout = 3000;
                    c.SendTimeout = 3000;
                    NetworkStream s = c.GetStream();
                    byte[] ask = Encoding.ASCII.GetBytes("GET /__local/token HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\nConnection: close\r\n\r\n");
                    s.Write(ask, 0, ask.Length);
                    byte[] buf = new byte[4096];
                    int got = 0, n;
                    while (got < buf.Length && (n = s.Read(buf, got, buf.Length - got)) > 0) got += n;
                    return Encoding.ASCII.GetString(buf, 0, got).Contains("\"token\"");
                }
            }
            catch { return false; }
        }

        private static void Log(string text)
        {
            if (string.IsNullOrEmpty(logFile)) return;
            try
            {
                lock (gate) { File.AppendAllText(logFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "  " + text + Environment.NewLine); }
            }
            catch { }
        }

        // ---- one request ----------------------------------------------------------------------
        private static void Serve(object state)
        {
            TcpClient client = (TcpClient)state;
            try
            {
                client.ReceiveTimeout = 4000;
                client.SendTimeout = 15000;
                client.NoDelay = true;
                NetworkStream stream = client.GetStream();
                string head = ReadHead(stream);
                if (head == null) return;
                string[] lines = head.Split(new string[] { "\r\n" }, StringSplitOptions.None);
                string[] parts = lines[0].Split(' ');
                if (parts.Length < 2 || (parts[0] != "GET" && parts[0] != "HEAD"))
                {
                    Reply(stream, 405, "Method Not Allowed", "text/plain", null, "", false);
                    return;
                }
                bool headOnly = parts[0] == "HEAD";
                Dictionary<string, string> headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                for (int i = 1; i < lines.Length; i++)
                {
                    if (lines[i].Length == 0) break;
                    int colon = lines[i].IndexOf(':');
                    if (colon > 0) headers[lines[i].Substring(0, colon).Trim()] = lines[i].Substring(colon + 1).Trim();
                }
                // Only answer when the browser is really asking for this computer's own address.
                string hostName = Header(headers, "host").ToLowerInvariant();
                if (hostName == "localhost:" + port)
                {
                    Reply(stream, 302, "Found", "text/plain", null, "Location: " + url + "\r\n", false);
                    return;
                }
                if (hostName != "127.0.0.1:" + port)
                {
                    Reply(stream, 403, "Forbidden", "text/plain", null, "", false);
                    return;
                }
                string target = parts[1];
                int mark = target.IndexOf('?');
                string rawPath = mark < 0 ? target : target.Substring(0, mark);
                string path = Uri.UnescapeDataString(rawPath).TrimStart('/');
                if (path.StartsWith("__", StringComparison.Ordinal))
                {
                    Dictionary<string, string> query = ParseQuery(mark < 0 ? "" : target.Substring(mark + 1));
                    HandleHelper(client, stream, headOnly, path, query, headers);
                    return;
                }
                ServeAppFile(stream, headOnly, path);
            }
            catch { }
            finally
            {
                try { client.Client.Shutdown(SocketShutdown.Send); } catch { }
                try { client.Close(); } catch { }
            }
        }

        private static string ReadHead(Stream stream)
        {
            byte[] buf = new byte[16384];
            int n = 0;
            while (n < buf.Length)
            {
                int r = stream.Read(buf, n, buf.Length - n);
                if (r <= 0) break;
                n += r;
                for (int i = Math.Max(0, n - r - 3); i + 3 < n; i++)
                {
                    if (buf[i] == 13 && buf[i + 1] == 10 && buf[i + 2] == 13 && buf[i + 3] == 10) return Encoding.ASCII.GetString(buf, 0, i);
                }
            }
            return n > 0 ? Encoding.ASCII.GetString(buf, 0, n) : null;
        }

        private static Dictionary<string, string> ParseQuery(string text)
        {
            Dictionary<string, string> query = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (string pair in text.Split('&'))
            {
                if (pair.Length == 0) continue;
                int eq = pair.IndexOf('=');
                string key = eq < 0 ? pair : pair.Substring(0, eq);
                string value = eq < 0 ? "" : pair.Substring(eq + 1);
                try { query[Uri.UnescapeDataString(key)] = Uri.UnescapeDataString(value.Replace('+', ' ')); } catch { }
            }
            return query;
        }

        private static string Header(Dictionary<string, string> headers, string name)
        {
            string value;
            return headers.TryGetValue(name, out value) ? value : "";
        }

        private static string Q(Dictionary<string, string> query, string name)
        {
            string value;
            return query.TryGetValue(name, out value) ? value : "";
        }

        private static void Reply(Stream stream, int code, string status, string type, byte[] body, string extra, bool headOnly)
        {
            int length = body == null ? 0 : body.Length;
            string head = "HTTP/1.1 " + code + " " + status + "\r\nContent-Type: " + type + "\r\nContent-Length: " + length +
                          "\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\n" + extra + "Connection: close\r\n\r\n";
            byte[] bytes = Encoding.ASCII.GetBytes(head);
            stream.Write(bytes, 0, bytes.Length);
            if (length > 0 && !headOnly) stream.Write(body, 0, length);
            stream.Flush();
        }

        private static void Json(Stream stream, int code, string status, string json)
        {
            Reply(stream, code, status, "application/json", Encoding.UTF8.GetBytes(json), "", false);
        }

        // ---- the app's own files --------------------------------------------------------------
        private static void ServeAppFile(Stream stream, bool headOnly, string path)
        {
            string file = null;
            if (path.Length > 0 && !path.Contains("..") && path.IndexOf(':') < 0 && path.IndexOf('\\') < 0)
            {
                string candidate = Path.GetFullPath(Path.Combine(appRoot, path));
                if (candidate.StartsWith(appRoot + Sep, StringComparison.OrdinalIgnoreCase) && File.Exists(candidate)) file = candidate;
            }
            if (file == null)
            {
                if (Path.GetExtension(path).Length > 0)
                {
                    Reply(stream, 404, "Not Found", "text/plain", null, "", false);
                    return;
                }
                // "/", "/callback" and any other page address all load the app itself.
                file = Path.Combine(appRoot, "index.html");
            }
            string type;
            if (!Types.TryGetValue(Path.GetExtension(file), out type)) type = "application/octet-stream";
            Reply(stream, 200, "OK", type, File.ReadAllBytes(file), "", headOnly);
        }

        // ---- the player's own requests (addresses that start with /__) ------------------------------
        private static void HandleHelper(TcpClient client, Stream stream, bool headOnly, string path, Dictionary<string, string> query, Dictionary<string, string> headers)
        {
            // Only the player itself may ask: not another website open in a browser.
            string site = Header(headers, "sec-fetch-site");
            if (site.Length > 0 && site != "same-origin" && site != "none")
            {
                Reply(stream, 403, "Forbidden", "text/plain", null, "", false);
                return;
            }
            if (path == "__local/token") { Json(stream, 200, "OK", "{\"token\":\"" + token + "\",\"version\":2}"); return; }
            if (!string.Equals(Q(query, "t"), token, StringComparison.Ordinal)) { Json(stream, 403, "Forbidden", "{\"error\":\"pass\"}"); return; }
            if (path == "__local/list") { Json(stream, 200, "OK", MusicList()); return; }
            if (path == "__local/file") { SendMusic(client, stream, headOnly, query, headers); return; }
            if (path == "__lyrics") { Lyrics(stream, query); return; }
            Reply(stream, 404, "Not Found", "text/plain", null, "", false);
        }

        // ---- Local Files ------------------------------------------------------------------------
        private static string JsonText(string s)
        {
            StringBuilder sb = new StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (char ch in s)
            {
                if (ch < 0x20 || ch > 0x7e || ch == '"' || ch == '\\') sb.Append("\\u").Append(((int)ch).ToString("x4"));
                else sb.Append(ch);
            }
            return sb.Append('"').ToString();
        }

        private static string CleanDir(string p)
        {
            string full = Path.GetFullPath(p);
            if (full.Length > 3) full = full.TrimEnd(Seps);
            return full.Length == 0 ? p : full;
        }

        private static string Inside(string root)
        {
            return root.TrimEnd(Seps) + Sep;
        }

        // Your Music folder, plus any folders listed in "Local folders.txt" (one per line).
        private static List<string> GetMusicRoots()
        {
            List<string> wanted = new List<string>();
            string first = MusicDir;
            if (string.IsNullOrEmpty(first)) { try { first = Environment.GetFolderPath(Environment.SpecialFolder.MyMusic); } catch { first = ""; } }
            if (!string.IsNullOrEmpty(first)) wanted.Add(first);
            try
            {
                string extra = Path.Combine(home, "Local folders.txt");
                if (File.Exists(extra))
                {
                    foreach (string line in File.ReadAllLines(extra))
                    {
                        string p = line.Trim().Trim('"');
                        if (p.Length > 0 && !p.StartsWith("#", StringComparison.Ordinal)) wanted.Add(p);
                    }
                }
            }
            catch { }
            List<string> list = new List<string>();
            foreach (string p in wanted)
            {
                try
                {
                    string full = CleanDir(p);
                    if (!Directory.Exists(full)) continue;
                    bool inside = false;
                    foreach (string have in list)
                    {
                        if (full.Equals(have, StringComparison.OrdinalIgnoreCase) || full.StartsWith(Inside(have), StringComparison.OrdinalIgnoreCase)) inside = true;
                    }
                    if (!inside) list.Add(full);
                }
                catch { }
            }
            lock (gate) { musicRoots = list; }
            return list;
        }

        private static string MusicList()
        {
            List<string> roots = GetMusicRoots();
            DateTime epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            FileAttributes skip = FileAttributes.Hidden | FileAttributes.System | FileAttributes.ReparsePoint;
            StringBuilder sb = new StringBuilder();
            int count = 0;
            for (int ri = 0; ri < roots.Count; ri++)
            {
                string bas = roots[ri];
                Stack<KeyValuePair<string, int>> stack = new Stack<KeyValuePair<string, int>>();
                stack.Push(new KeyValuePair<string, int>(bas, 0));
                while (stack.Count > 0 && count < MaxFiles)
                {
                    KeyValuePair<string, int> item = stack.Pop();
                    try
                    {
                        DirectoryInfo info = new DirectoryInfo(item.Key);
                        foreach (FileInfo f in info.GetFiles())
                        {
                            if (count >= MaxFiles) break;
                            if (!Audio.ContainsKey(f.Extension)) continue;
                            string rel = f.FullName.Substring(bas.Length).TrimStart(Seps).Replace('\\', '/');
                            long when = (long)(f.LastWriteTimeUtc - epoch).TotalSeconds;
                            if (count > 0) sb.Append(',');
                            sb.Append('[').Append(ri).Append(',').Append(JsonText(rel)).Append(',')
                              .Append(f.Length.ToString(CultureInfo.InvariantCulture)).Append(',').Append(when.ToString(CultureInfo.InvariantCulture)).Append(']');
                            count++;
                        }
                        if (item.Value < 8)
                        {
                            foreach (DirectoryInfo d in info.GetDirectories())
                            {
                                if ((d.Attributes & skip) != 0) continue;
                                stack.Push(new KeyValuePair<string, int>(d.FullName, item.Value + 1));
                            }
                        }
                    }
                    catch { }
                }
            }
            StringBuilder names = new StringBuilder();
            for (int i = 0; i < roots.Count; i++) { if (i > 0) names.Append(','); names.Append(JsonText(roots[i])); }
            return "{\"roots\":[" + names + "],\"more\":" + (count >= MaxFiles ? "true" : "false") + ",\"files\":[" + sb + "]}";
        }

        // Sends (part of) one music file.
        private static void SendMusic(TcpClient client, Stream stream, bool headOnly, Dictionary<string, string> query, Dictionary<string, string> headers)
        {
            List<string> roots;
            lock (gate) { roots = musicRoots; }
            if (roots == null) roots = GetMusicRoots();
            int ri;
            if (!int.TryParse(Q(query, "r"), NumberStyles.Integer, CultureInfo.InvariantCulture, out ri) || ri < 0 || ri >= roots.Count)
            {
                Reply(stream, 404, "Not Found", "text/plain", null, "", false);
                return;
            }
            string rel = Q(query, "p");
            if (rel.Length == 0 || DotDot.IsMatch(rel) || rel.IndexOf(':') >= 0)
            {
                Reply(stream, 404, "Not Found", "text/plain", null, "", false);
                return;
            }
            string bas = roots[ri];
            string full = Path.GetFullPath(Path.Combine(bas, rel));
            string type;
            if (!full.StartsWith(Inside(bas), StringComparison.OrdinalIgnoreCase) || !Audio.TryGetValue(Path.GetExtension(full), out type) || !File.Exists(full))
            {
                Reply(stream, 404, "Not Found", "text/plain", null, "", false);
                return;
            }
            using (FileStream fs = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 65536))
            {
                long len = fs.Length, start = 0, end = len - 1;
                bool partial = false;
                Match m = RangeHeader.Match(Header(headers, "range"));
                if (m.Success)
                {
                    string a = m.Groups[1].Value, b = m.Groups[2].Value;
                    long x;
                    if (a.Length > 0 && long.TryParse(a, NumberStyles.None, CultureInfo.InvariantCulture, out x))
                    {
                        start = x;
                        long y;
                        if (b.Length > 0 && long.TryParse(b, NumberStyles.None, CultureInfo.InvariantCulture, out y)) end = Math.Min(y, len - 1);
                        partial = true;
                    }
                    else if (a.Length == 0 && b.Length > 0 && long.TryParse(b, NumberStyles.None, CultureInfo.InvariantCulture, out x))
                    {
                        start = Math.Max(0, len - x);
                        partial = true;
                    }
                }
                if (partial && (start >= len || end < start))
                {
                    Reply(stream, 416, "Range Not Satisfiable", "text/plain", null, "Content-Range: bytes */" + len + "\r\n", false);
                    return;
                }
                long count = end - start + 1;
                string line = partial ? "HTTP/1.1 206 Partial Content" : "HTTP/1.1 200 OK";
                string extra = partial ? "Content-Range: bytes " + start + "-" + end + "/" + len + "\r\n" : "";
                string head = line + "\r\nContent-Type: " + type + "\r\nContent-Length: " + count + "\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n" + extra + "Connection: close\r\n\r\n";
                byte[] bytes = Encoding.ASCII.GetBytes(head);
                stream.Write(bytes, 0, bytes.Length);
                if (headOnly || count <= 0) { stream.Flush(); return; }
                // The player may stop reading for a while when it has enough of the song buffered.
                client.SendTimeout = 120000;
                fs.Position = start;
                byte[] buf = new byte[65536];
                long left = count;
                while (left > 0 && running)
                {
                    int n = fs.Read(buf, 0, (int)Math.Min(buf.Length, left));
                    if (n <= 0) break;
                    stream.Write(buf, 0, n);
                    left -= n;
                }
                stream.Flush();
            }
        }

        // ---- Lyrics ------------------------------------------------------------------------------
        // Only the song's title, artist, album and length are sent, to lrclib.net. Nothing about you.
        private static HttpClient Http()
        {
            lock (gate)
            {
                if (http == null)
                {
                    try { ServicePointManager.SecurityProtocol = ServicePointManager.SecurityProtocol | SecurityProtocolType.Tls12; } catch { }
                    HttpClient c = new HttpClient();
                    c.Timeout = TimeSpan.FromSeconds(10);
                    c.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", "Glasswave/1.2 (personal music player)");
                    http = c;
                }
                return http;
            }
        }

        private static void Lyrics(Stream stream, Dictionary<string, string> query)
        {
            string kind = Q(query, "kind") == "search" ? "search" : "get";
            List<string> pairs = new List<string>();
            foreach (string name in new string[] { "track_name", "artist_name", "album_name", "duration" })
            {
                string value = Q(query, name);
                if (value.Length > 0) pairs.Add(name + "=" + Uri.EscapeDataString(value));
            }
            if (pairs.Count == 0) { Json(stream, 400, "Bad Request", "{\"error\":\"nothing to look up\"}"); return; }
            string target = LyricsBase.TrimEnd('/') + "/api/" + kind + "?" + string.Join("&", pairs.ToArray());
            byte[] body = null;
            int code = 0;
            try
            {
                using (HttpResponseMessage r = Http().GetAsync(target).Result)
                {
                    code = (int)r.StatusCode;
                    if (code == 200) body = r.Content.ReadAsByteArrayAsync().Result;
                }
            }
            catch { code = -1; }
            if (code == 200 && body != null) Reply(stream, 200, "OK", "application/json", body, "", false);
            else if (code == 404) Json(stream, 404, "Not Found", "{\"name\":\"TrackNotFound\"}");
            else if (code > 0) Json(stream, 502, "Bad Gateway", "{\"error\":\"lyrics site answered " + code + "\"}");
            else Json(stream, 502, "Bad Gateway", "{\"error\":\"lyrics site could not be reached\"}");
        }
    }
}
