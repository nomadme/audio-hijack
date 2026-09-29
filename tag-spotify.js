// #needsFile

console.log("=== FLAC TAGGING SCRIPT (MULTI-API GENRE FALLBACK) ===");

if (typeof event !== "undefined" && event.file && event.file.filePath) {
  const filePath = event.file.filePath;

  // 1. Fetch Track ID, Title, Primary Artist, Album, and Cover Art URL via AppleScript
  const getMetadataPython = `
import subprocess, sys

applescript = '''
tell application "Spotify"
  if player state is playing or player state is paused then
    set trackUri to id of current track
    set trackName to name of current track
    set primaryArtist to artist of current track
    set albumName to album of current track
    set artworkUrl to artwork url of current track
    return trackUri & "|||" & trackName & "|||" & primaryArtist & "|||" & albumName & "|||" & artworkUrl
  else
    return ""
  end if
end tell
'''

p = subprocess.Popen(['osascript', '-e', applescript], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
out, err = p.communicate()
sys.stdout.buffer.write(out)
`;

  const fetchCmd = `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8; python3 -c ${app.shellEscapeArgument(getMetadataPython)}`;
  const [status, stdout, stderr] = app.runShellCommand(fetchCmd);

  if (status === 0 && stdout.trim() !== "") {
    const parts = stdout.trim().split("|||");
    if (parts.length >= 5) {
      const trackUri = parts[0];
      const title = parts[1];
      const primaryArtist = parts[2];
      const realAlbum = parts[3];
      const artworkUrl = parts[4];

      const trackId = trackUri.includes(":") ? trackUri.split(":").pop() : "";

      console.log(`Fetched Metadata -> Title: "${title}" | Artist: "${primaryArtist}" | Album: "${realAlbum}"`);

      const dir = filePath.substring(0, filePath.lastIndexOf('/'));
      const tempArtPath = `${dir}/temp_cover.jpg`;

      // 2. Download cover artwork
      let hasCover = false;
      if (artworkUrl && artworkUrl.startsWith("http")) {
        const downloadArtCmd = `curl -s -o ${app.shellEscapeArgument(tempArtPath)} ${app.shellEscapeArgument(artworkUrl)}`;
        const [artStatus] = app.runShellCommand(downloadArtCmd);
        if (artStatus === 0) {
          hasCover = true;
        }
      }

      // 3. Multi-Tier Genre Engine: Last.fm -> iTunes -> MusicBrainz -> Default
      const pyTagScript = `
import subprocess, sys, os, urllib.request, urllib.parse, re, shutil, json

file_path = sys.argv[1]
track_id = sys.argv[2]
title = sys.argv[3]
primary_artist = sys.argv[4]
album = sys.argv[5]
art_path = sys.argv[6]

artists = []
genre = ""

# Step A: Parse multi-artists from Spotify embed page
if track_id:
    try:
        url = f"https://open.spotify.com/embed/track/{track_id}"
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'})
        with urllib.request.urlopen(req, timeout=4) as response:
            html = response.read().decode('utf-8')
            match = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html)
            if match:
                data = json.loads(match.group(1))
                entity = data.get('props', {}).get('pageProps', {}).get('state', {}).get('data', {}).get('entity', {})
                if 'artists' in entity and isinstance(entity['artists'], list):
                    artists = [a['name'] for a in entity['artists'] if 'name' in a]
    except Exception:
        pass

if not artists:
    clean_str = re.sub(r'\\s+(?:feat\\.|ft\\.|with|featuring)\\s+', ', ', primary_artist, flags=re.IGNORECASE)
    artists = [a.strip() for a in clean_str.replace('&', ',').split(',') if a.strip()]

first_artist = artists[0] if artists else primary_artist

# --- GENRE LOOKUP PIPELINE ---

# 1. Last.fm Track Tag
try:
    api_key = "2f10b377ee13735ff883ff1c83fa8892"
    q_track = urllib.parse.quote(title)
    q_artist = urllib.parse.quote(first_artist)
    
    url = f"http://ws.audioscrobbler.com/2.0/?method=track.getInfo&api_key={api_key}&artist={q_artist}&track={q_track}&format=json"
    req = urllib.request.Request(url, headers={'User-Agent': 'AudioHijack/1.0'})
    with urllib.request.urlopen(req, timeout=3) as response:
        res = json.loads(response.read().decode('utf-8'))
        tags = res.get('track', {}).get('toptags', {}).get('tag', [])
        if tags and isinstance(tags, list) and len(tags) > 0:
            genre = tags[0].get('name', '').title()
except Exception:
    pass

# 2. Last.fm Artist Tag Fallback
if not genre:
    try:
        url_art = f"http://ws.audioscrobbler.com/2.0/?method=artist.getTopTags&api_key={api_key}&artist={q_artist}&format=json"
        req_art = urllib.request.Request(url_art, headers={'User-Agent': 'AudioHijack/1.0'})
        with urllib.request.urlopen(req_art, timeout=3) as response:
            res_art = json.loads(response.read().decode('utf-8'))
            tags = res_art.get('toptags', {}).get('tag', [])
            if tags and isinstance(tags, list):
                for t in tags:
                    tag_name = t.get('name', '').title()
                    if tag_name.lower() not in ['seen live', 'favorite', 'favourites', 'awesome', 'female vocalists', 'male vocalists']:
                        genre = tag_name
                        break
    except Exception:
        pass

# 3. iTunes Search API Fallback
if not genre:
    try:
        term = urllib.parse.quote(f"{first_artist} {title}")
        itunes_url = f"https://itunes.apple.com/search?term={term}&entity=song&limit=1"
        req_it = urllib.request.Request(itunes_url, headers={'User-Agent': 'AudioHijack/1.0'})
        with urllib.request.urlopen(req_it, timeout=3) as response:
            it_data = json.loads(response.read().decode('utf-8'))
            results = it_data.get('results', [])
            if results and 'primaryGenreName' in results[0]:
                genre = results[0]['primaryGenreName']
    except Exception:
        pass

# 4. MusicBrainz API Fallback
if not genre:
    try:
        mb_query = urllib.parse.quote(f'artist:"{first_artist}" AND recording:"{title}"')
        mb_url = f"https://musicbrainz.org/ws/2/recording/?query={mb_query}&fmt=json&limit=1"
        req_mb = urllib.request.Request(mb_url, headers={'User-Agent': 'AudioHijackTagger/1.0 (contact@local)'})
        with urllib.request.urlopen(req_mb, timeout=3) as response:
            mb_data = json.loads(response.read().decode('utf-8'))
            recs = mb_data.get('recordings', [])
            if recs and 'tags' in recs[0] and recs[0]['tags']:
                genre = recs[0]['tags'][0]['name'].title()
    except Exception:
        pass

# 5. Default Fallback Genre (Customizable)
if not genre:
    genre = "General"

formatted_artists = ", ".join(artists)
print(f"PARSED_ARTISTS:{formatted_artists}")
print(f"PARSED_GENRE:{genre}")

metaflac = shutil.which('metaflac') or '/opt/homebrew/bin/metaflac'

cmd = [
    metaflac,
    '--remove-all-tags',
    f'--set-tag=TITLE={title}',
    f'--set-tag=ALBUM={album}',
    f'--set-tag=GENRE={genre}',
]

for a in artists:
    cmd.append(f'--set-tag=ARTIST={a}')

if art_path and os.path.exists(art_path):
    cmd.append(f'--import-picture-from={art_path}')

cmd.append(file_path)

res = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8')
if res.returncode == 0:
    print("SUCCESS")
else:
    print("ERROR: " + res.stderr)
`;

      const tagCmd = `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8; python3 -c ${app.shellEscapeArgument(pyTagScript)} ${app.shellEscapeArgument(filePath)} ${app.shellEscapeArgument(trackId)} ${app.shellEscapeArgument(title)} ${app.shellEscapeArgument(primaryArtist)} ${app.shellEscapeArgument(realAlbum)} ${app.shellEscapeArgument(hasCover ? tempArtPath : "")}`;
      const [tagStatus, tagOut, tagErr] = app.runShellCommand(tagCmd);

      let finalArtistString = primaryArtist;
      let finalGenre = "General";

      if (tagOut.includes("PARSED_ARTISTS:")) {
        const line = tagOut.split("\n").find(l => l.startsWith("PARSED_ARTISTS:"));
        if (line) finalArtistString = line.replace("PARSED_ARTISTS:", "").trim();
      }

      if (tagOut.includes("PARSED_GENRE:")) {
        const line = tagOut.split("\n").find(l => l.startsWith("PARSED_GENRE:"));
        if (line && line.replace("PARSED_GENRE:", "").trim()) {
          finalGenre = line.replace("PARSED_GENRE:", "").trim();
        }
      }

      if (tagOut.includes("SUCCESS")) {
        console.log(`SUCCESS: Tagged FLAC [Artist: ${finalArtistString} | Album: ${realAlbum} | Genre: ${finalGenre}]`);
      } else {
        console.log("ERROR writing tags/art: " + tagOut + " | " + tagErr);
      }

      if (hasCover) {
        app.runShellCommand(`rm -f ${app.shellEscapeArgument(tempArtPath)}`);
      }

      // 4. Rename file
      const safeArtist = finalArtistString.replace(/[/\\?%*:|"<>]/g, '').trim();
      const safeTitle = title.replace(/[/\\?%*:|"<>]/g, '').trim();
      const newFilePath = `${dir}/${safeArtist} - ${safeTitle}.flac`;

      const renameCmd = `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8; mv ${app.shellEscapeArgument(filePath)} ${app.shellEscapeArgument(newFilePath)}`;
      const [renameStatus] = app.runShellCommand(renameCmd);

      if (renameStatus === 0) {
        console.log(`Renamed file to: ${safeArtist} - ${safeTitle}.flac`);
      } else {
        console.log("Failed to rename file.");
      }
    }
  } else {
    console.log("Could not extract Spotify metadata.");
  }
} else {
  console.log("No valid recorded file found.");
}