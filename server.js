import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import ffmpegLib from 'fluent-ffmpeg';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import morgan from 'morgan';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Env ---
const PORT = process.env.PORT || 3000;
const DROPBOX_TOKEN = process.env.DROPBOX_ACCESS_TOKEN;

// --- FFmpeg path (Render has no system ffmpeg) ---
ffmpegLib.setFfmpegPath(ffmpegPath.path);

// --- App setup ---
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(morgan('combined'));

// --- Helpers ---
function log(step, extra = {}) {
  const payload = { ts: new Date().toISOString(), step, ...extra };
  console.log(JSON.stringify(payload));
}

function tmpFile(suffix = '.bin') {
  return path.join(os.tmpdir(), `${randomUUID()}${suffix}`);
}

function isDropboxSharedLink(url) {
  try {
    const u = new URL(url);
    return u.hostname.endsWith('dropbox.com') || u.hostname.endsWith('db.tt');
  } catch {
    return false;
  }
}

function toDirectDownload(url) {
  // Convert ?dl=0 to ?dl=1; if no param, append dl=1
  try {
    const u = new URL(url);
    if (u.searchParams.has('dl')) {
      u.searchParams.set('dl', '1');
    } else {
      u.searchParams.append('dl', '1');
    }
    return u.toString();
  } catch {
    return url;
  }
}

async function dropboxTemporaryLinkByPath(dbxPath) {
  if (!DROPBOX_TOKEN) throw new Error('Missing DROPBOX_ACCESS_TOKEN env var');
  const resp = await axios.post(
    'https://api.dropboxapi.com/2/files/get_temporary_link',
    { path: dbxPath },
    { headers: { Authorization: `Bearer ${DROPBOX_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 120000 }
  );
  return resp.data.link;
}

async function downloadToTemp({ url = null, dropboxPath = null, extFallback = '.bin' }) {
  let directUrl = url;
  if (!directUrl && dropboxPath) {
    directUrl = await dropboxTemporaryLinkByPath(dropboxPath);
  }
  if (!directUrl) throw new Error('Provide either url or dropboxPath');
  if (isDropboxSharedLink(directUrl)) {
    directUrl = toDirectDownload(directUrl);
  }
  const outFile = tmpFile(extFallback);
  log('download.start', { directUrl });
  const resp = await axios.get(directUrl, { responseType: 'stream', timeout: 0 });
  await pipeline(resp.data, fs.createWriteStream(outFile));
  log('download.done', { outFile });
  return outFile;
}

// Dropbox upload: small (<150MB) and large files (chunked) support
async function dropboxUpload(localPath, dropboxDestPath) {
  const stat = fs.statSync(localPath);
  const size = stat.size;
  const CHUNK = 8 * 1024 * 1024; // 8MB
  const headersJSON = { Authorization: `Bearer ${DROPBOX_TOKEN}`, 'Content-Type': 'application/json' };

  if (size <= 150 * 1024 * 1024) {
    const content = fs.readFileSync(localPath);
    const args = {
      path: dropboxDestPath,
      mode: 'overwrite',
      autorename: false,
      mute: false
    };
    const resp = await axios.post(
      'https://content.dropboxapi.com/2/files/upload',
      content,
      {
        headers: {
          Authorization: `Bearer ${DROPBOX_TOKEN}`,
          'Dropbox-API-Arg': JSON.stringify(args),
          'Content-Type': 'application/octet-stream'
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 0
      }
    );
    return resp.data;
  }

  // Chunked upload
  const startArgs = { close: false };
  const startResp = await axios.post(
    'https://content.dropboxapi.com/2/files/upload_session/start',
    '',
    {
      headers: {
        Authorization: `Bearer ${DROPBOX_TOKEN}`,
        'Dropbox-API-Arg': JSON.stringify(startArgs),
        'Content-Type': 'application/octet-stream'
      },
      timeout: 0
    }
  );
  const sessionId = startResp.data.session_id;
  const fd = fs.openSync(localPath, 'r');
  let offset = 0;
  const buffer = Buffer.alloc(CHUNK);
  try {
    while (offset < size) {
      const toRead = Math.min(CHUNK, size - offset);
      const { bytesRead } = fs.readSync(fd, buffer, 0, toRead, offset);
      const isLast = offset + bytesRead >= size;
      if (!isLast) {
        await axios.post(
          'https://content.dropboxapi.com/2/files/upload_session/append_v2',
          buffer.subarray(0, bytesRead),
          {
            headers: {
              Authorization: `Bearer ${DROPBOX_TOKEN}`,
              'Dropbox-API-Arg': JSON.stringify({ cursor: { session_id: sessionId, offset }, close: false }),
              'Content-Type': 'application/octet-stream'
            },
            timeout: 0,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
          }
        );
      } else {
        const commit = {
          cursor: { session_id: sessionId, offset },
          commit: { path: dropboxDestPath, mode: 'overwrite', autorename: false, mute: false }
        };
        await axios.post(
          'https://content.dropboxapi.com/2/files/upload_session/finish',
          buffer.subarray(0, bytesRead),
          {
            headers: {
              Authorization: `Bearer ${DROPBOX_TOKEN}`,
              'Dropbox-API-Arg': JSON.stringify(commit),
              'Content-Type': 'application/octet-stream'
            },
            timeout: 0,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
          }
        );
      }
      offset += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { path_display: dropboxDestPath, size };
}

// --- Core merge endpoint ---
/**
 * POST /merge
 * Body JSON:
 * {
 *   "audio_url": "https://...mp3" OR "audio_path": "/Apps/YourApp/in.mp3" (Dropbox path),
 *   "video_url": "https://...mp4" OR "video_path": "/Apps/YourApp/in.mp4" (Dropbox path),
 *   "out_path": "/Apps/YourApp/merged/output.mp4", // Dropbox destination path
 *   "audio_offset_sec": 0,     // optional, shift audio forward (+) or backward (-)
 *   "trim_to_shortest": true,  // optional, end when shorter stream ends
 *   "reencode_video": false,   // optional, default false: copy video stream if possible
 *   "audio_bitrate": "192k"    // optional, default 192k
 * }
 */
app.post('/merge', async (req, res) => {
  const start = Date.now();
  try {
    if (!DROPBOX_TOKEN) {
      return res.status(400).json({ error: 'Server missing DROPBOX_ACCESS_TOKEN env var' });
    }

    const {
      audio_url,
      video_url,
      audio_path,
      video_path,
      out_path,
      audio_offset_sec = 0,
      trim_to_shortest = true,
      reencode_video = false,
      audio_bitrate = '192k'
    } = req.body || {};

    if (!out_path) {
      return res.status(400).json({ error: 'Missing out_path (Dropbox destination path)' });
    }
    if (!(audio_url || audio_path)) return res.status(400).json({ error: 'Provide audio_url or audio_path' });
    if (!(video_url || video_path)) return res.status(400).json({ error: 'Provide video_url or video_path' });

    // Download inputs to temp files
    const audioTmp = await downloadToTemp({
      url: audio_url,
      dropboxPath: audio_path,
      extFallback: '.mp3'
    });
    const videoTmp = await downloadToTemp({
      url: video_url,
      dropboxPath: video_path,
      extFallback: '.mp4'
    });

    // Prepare output temp path
    const outTmp = tmpFile('.mp4');

    // Build FFmpeg command
    const cmd = ffmpegLib()
      .input(videoTmp)
      .input(audioTmp);

    // Apply audio offset if requested
    if (audio_offset_sec !== 0) {
      if (audio_offset_sec > 0) {
        cmd.inputOptions(['-itsoffset', String(audio_offset_sec)]).input(audioTmp);
      } else {
        // negative offset: delay video instead (workaround)
        cmd.inputOptions(['-itsoffset', String(-audio_offset_sec)]).input(videoTmp);
      }
    }

    if (trim_to_shortest) {
      cmd.outputOptions(['-shortest']);
    }

    // Re-encode video or stream copy
    if (reencode_video) {
      cmd.videoCodec('libx264');
      cmd.outputOptions(['-preset', 'veryfast', '-movflags', '+faststart']);
    } else {
      cmd.outputOptions(['-c:v', 'copy']);
    }

    // Always encode audio to AAC for MP4 container
    cmd.audioCodec('aac').audioBitrate(audio_bitrate);

    await new Promise((resolve, reject) => {
      cmd
        .on('start', commandLine => log('ffmpeg.start', { commandLine }))
        .on('progress', p => log('ffmpeg.progress', p))
        .on('error', (err, stdout, stderr) => {
          log('ffmpeg.error', { err: err.message, stdout, stderr });
          reject(err);
        })
        .on('end', () => {
          log('ffmpeg.done', { outTmp });
          resolve();
        })
        .save(outTmp);
    });

    // Upload to Dropbox
    const uploaded = await dropboxUpload(outTmp, out_path);

    // Cleanup
    for (const f of [audioTmp, videoTmp, outTmp]) {
      try { fs.unlinkSync(f); } catch {}
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    return res.json({
      ok: true,
      out_path,
      uploaded,
      elapsed_sec: elapsed
    });
  } catch (err) {
    log('merge.error', { message: err.message, stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.type('text').send('FFmpeg + Dropbox Merger is running. POST /merge to combine audio/video.');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});