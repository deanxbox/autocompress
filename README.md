# AutoCompress (Vencord Plugin)
- AutoCompress is a Vencord plugin that automatically compresses videos, audio, images, and other applicable media upon attempted send that exceed a configurable size limit, reducing them to a specified target size

## Features
- customizable compression settings, target file size, compression thresholds, etc.

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
- ensure you set a realistic time limit 
- lower resolution scaling can help encoding speed & artifacting 
- GPU encoders are preferred when available (`h264_nvenc`, `h264_amf`, `h264_qsv`, or `h264_videotoolbox`), with software `libx264` as the final fallback
- very large source videos may be retried at 1080p on GPU if the hardware encoder rejects the original resolution
- large JPEG, PNG, and WebP images are compressed in-browser and are only intercepted when they exceed the configured threshold
