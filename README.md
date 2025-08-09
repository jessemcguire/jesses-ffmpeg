# FFmpeg + Dropbox Merger (Render)

Merge an **MP3** (audio) and **MP4** (video) using FFmpeg on Render, then upload the output to **Dropbox**.

## 1) What you'll need
- Render account
- Dropbox access token (App Console -> Scoped app -> `files.content.write`, `files.content.read`).
- Node 18+ locally if you want to run/test.

## 2) Deploy to Render
1. Create a new **Web Service** on Render and connect this repo (or upload).
2. Set environment variable: `DROPBOX_ACCESS_TOKEN` to your Dropbox token.
3. Deploy. Render will start the server (no build step required).

## 3) Endpoint
`POST /merge`

```jsonc
{
  "audio_url": "https://www.dropbox.com/s/.../voice.mp3?dl=1",  // OR: "audio_path": "/Apps/YourApp/voice.mp3"
  "video_url": "https://www.dropbox.com/s/.../broll.mp4?dl=1",  // OR: "video_path": "/Apps/YourApp/broll.mp4"
  "out_path": "/Apps/YourApp/outputs/final.mp4",                // Dropbox destination path
  "audio_offset_sec": 0,        // optional (shift audio)
  "trim_to_shortest": true,     // optional (default true)
  "reencode_video": false,      // optional (default false → copy video stream)
  "audio_bitrate": "192k"       // optional
}
```

You can send Dropbox **shared links** or Dropbox **paths**:
- If you pass `audio_path`/`video_path`, the server uses Dropbox's `files/get_temporary_link`.
- If you pass a shared link, the server converts it to a direct download (`?dl=1`).

### Example `curl`
```bash
curl -X POST https://<your-render-url>/merge   -H "Content-Type: application/json"   -d '{
    "audio_path": "/Apps/MyApp/incoming/voice.mp3",
    "video_path": "/Apps/MyApp/incoming/clip.mp4",
    "out_path": "/Apps/MyApp/outputs/merged-output.mp4",
    "audio_offset_sec": 0,
    "trim_to_shortest": true,
    "reencode_video": false
  }'
```

### Output
Response includes Dropbox metadata for the uploaded file. You can also generate a temporary link yourself with Dropbox's `files/get_temporary_link`.

## 4) Notes
- Render's disk is **ephemeral**; we download inputs to `/tmp`, render, upload to Dropbox, then delete temp files.
- For files **>150MB**, the app automatically switches to Dropbox's **chunked upload**.
- If you need hard re-encode (e.g., to normalize dimensions/codec), set `"reencode_video": true`.
- To end when the shorter stream ends, keep `"trim_to_shortest": true` (recommended).
- If your audio needs alignment, set `"audio_offset_sec"` to a positive or negative number.

## 5) Local dev
```bash
cp .env.example .env
# put your real token in .env
npm install
npm run dev
# then POST to http://localhost:3000/merge
```

## 6) Troubleshooting
- 401 from Dropbox → check `DROPBOX_ACCESS_TOKEN` scopes and value.
- FFmpeg errors about stream mapping → try `"reencode_video": true`.
- Long uploads on free plan may time out; consider a higher Render plan for heavy workloads.
```