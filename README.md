# AutoCompress (Vencord Plugin)
- AutoCompress is a Vencord plugin that automatically compresses videos, audio, images, and other applicable media upon attempted send that exceed a configurable size limit, reducing them to a specified target size

## Features
- customizable compression settings, target file size, compression thresholds, attachment type modes, and fallback behavior
- bounded concurrent compression jobs so multi-file uploads do not launch every ffmpeg encode at once
- progress overlay with ETA, upload cancellation, and a post-compression size preview
- optional custom image/video dimensions, plus quick preset limits
- optional prompt before compressing inserted media
- diagnostics button in settings for ffmpeg/GPU encoder troubleshooting

## How It Works
- works via reencoding media with ffmpeg 

## Installation
- https://docs.vencord.dev/installing/custom-plugins/

## Usage
- drag/drop, and paste are currently supported
- applicable files above the size set in settings are compressed to fit under size limit in settings upon attempted upload

## Notes
- requires [ffmpeg](https://github.com/FFmpeg/FFmpeg) (and ffprobe), plugin should automatically resolve binaries - if not, set a path in the plugin settings
- set a limit a bit below your ideal size
- target size and compression threshold can use KB, MB, or GB units
- use Compression Mode to limit compression to videos/audio, images, both, or neither
- enable "Prompt to compress after every media insertion" to choose between compression and uploading originals each time AutoCompress intercepts media
- failed files are skipped by default, but can optionally upload originals; compression results that are larger than the source can also optionally fall back to the original
- increasing Concurrent Jobs can improve GPU video engine usage on systems that can handle multiple simultaneous encodes
- ensure you set a realistic time limit 
- lower resolution scaling can help encoding speed & artifacting 
- GPU encoders are preferred when available (`h264_nvenc`, `h264_amf`, `h264_qsv`, or `h264_videotoolbox`), with software `libx264` as the final fallback
- video-like media, including MOV and GIF files, is reencoded to MP4; audio-only media is reencoded to M4A
- large outputs are retried at lower bitrates to get closer to the configured target
- very large source videos may be retried at 1080p on GPU if the hardware encoder rejects the original resolution
- large JPEG, PNG, and WebP images are compressed in-browser and are only intercepted when they exceed the configured threshold
