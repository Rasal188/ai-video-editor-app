import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { buildDynamicReframingTrack, buildReframingFFmpegCropFilter } from '../src/lib/shortsReframing.js';
import { resolveSmartFrameCropAtTime } from '../src/lib/smartFrame.js';

const videoPath = 'test-artifacts/twoperson-extracted/media/visuals/001-vidssave.com-Can-AI-Boost-Your-Creativity-As-A-Frontend-Developer_-ai-intern-learning-720P.mp4.mp4';
const detectionsPath = 'test-artifacts/candidate_212_248_detections/detections.json';
const outDir = 'test-artifacts/visual_verification_fixed';

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

async function main() {
  console.log('Loading ground-truth detections for 212.92 - 248.80...');
  const detections = JSON.parse(fs.readFileSync(detectionsPath, 'utf8'));

  const startTime = 212.92;
  const duration = 35.88;
  const sourceSize = { width: 1280, height: 720 };

  console.log('Building reframing track with fixed pipeline...');
  const track = buildDynamicReframingTrack({
    detections,
    duration,
    startTime,
    sourceStart: startTime,
    sourceSize,
    targetRatio: '9:16',
    sceneCuts: [216.7, 219.2],
  });

  console.log(`Generated track with ${track.cropKeyframes.length} keyframes.`);

  // Sample check framing across playback
  const sampleTimes = [0, 2.0, 3.8, 5.0, 10.0, 19.5, 25.0, 35.0];
  console.log('\n--- Playback Crop Coordinates Check ---');
  for (const st of sampleTimes) {
    const crop = resolveSmartFrameCropAtTime(track, st);
    const centerNorm = crop.x + crop.width / 2;
    console.log(`t=${st.toFixed(1)}s (source=${(startTime + st).toFixed(2)}s): x=${crop.x.toFixed(4)}, panFactor=${crop.panFactor.toFixed(4)}, cropCenter=${centerNorm.toFixed(4)}`);
  }

  // Render a 9:16 MP4 test clip using the reframing filter
  const targetWidth = 406; // 720 * (9/16) ≈ 405 -> 406 (even number for ffmpeg)
  const targetHeight = 720;
  
  // Use ffmpeg with animated crop or piecewise segments
  const outClipPath = path.join(outDir, 'fixed_shorts_clip_9x16.mp4');
  console.log(`\nRendering 9:16 test export to ${outClipPath}...`);
  
  // Test export using FFmpeg crop filter expression
  const filterExpr = buildReframingFFmpegCropFilter(track, targetWidth, targetHeight, duration);
  console.log(`FFmpeg filter:\n${filterExpr.substring(0, 150)}...`);

  const cmd = `ffmpeg -y -ss ${startTime} -t ${duration} -i "${videoPath}" -filter_complex "${filterExpr}" -c:v libx264 -preset ultrafast -crf 22 -c:a aac "${outClipPath}"`;
  execSync(cmd, { stdio: 'inherit' });
  console.log('Video render completed!');

  // Extract snapshot frames from the rendered 9:16 video for visual verification
  console.log('\nExtracting visual verification frames from rendered 9:16 video...');
  for (const st of [0, 2.0, 5.0, 10.0, 20.0, 35.0]) {
    const frameOut = path.join(outDir, `frame_9x16_t${st}s.jpg`);
    execSync(`ffmpeg -y -ss ${st} -i "${outClipPath}" -vframes 1 -q:v 2 "${frameOut}"`, { stdio: 'ignore' });
    console.log(`Extracted: ${frameOut}`);
  }

  console.log('\nVisual verification frames extracted successfully!');
}

main().catch(console.error);
