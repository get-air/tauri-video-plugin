#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixture_dir="$script_dir/fixtures"
mkdir -p "$fixture_dir"

video_30="testsrc2=size=640x360:rate=30:duration=6"
video_24="testsrc2=size=640x360:rate=24000/1001:duration=6"
audio_48="sine=frequency=440:sample_rate=48000:duration=6"

ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$video_30" -f lavfi -i "$audio_48" -map 0:v -map 1:a -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 30 -c:a aac -b:a 128k "$fixture_dir/h264-aac-30.mkv"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=60" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=60" -map 0:v -map 1:a -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 30 -b:v 5M -maxrate 5M -bufsize 10M -c:a aac -b:a 128k "$fixture_dir/h264-aac-long-30.mkv"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=1280x720:rate=60:duration=6" -f lavfi -i "$audio_48" -map 0:v -map 1:a -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 60 -c:a aac -b:a 128k "$fixture_dir/h264-aac-60.mkv"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$video_24" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=6" -f lavfi -i "sine=frequency=880:sample_rate=48000:duration=6" -i "$script_dir/subtitles.srt" -map 0:v -map 1:a -map 2:a -map 3:s -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 24 -c:a aac -b:a 96k -c:s srt -metadata:s:a:0 language=eng -metadata:s:a:0 title="English tone" -metadata:s:a:1 language=jpn -metadata:s:a:1 title="Japanese tone" -metadata:s:s:0 language=eng -metadata:s:s:0 title="Qualification captions" "$fixture_dir/h264-multitrack-subtitles.mkv"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=640x360:rate=30:duration=30" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=30" -f lavfi -i "sine=frequency=880:sample_rate=48000:duration=30" -i "$script_dir/subtitles-long.srt" -map 0:v -map 1:a -map 2:a -map 3:s -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 30 -c:a aac -b:a 96k -c:s srt -metadata:s:a:0 language=eng -metadata:s:a:0 title="English tone" -metadata:s:a:1 language=jpn -metadata:s:a:1 title="Japanese tone" -metadata:s:s:0 language=eng -metadata:s:s:0 title="Qualification captions" "$fixture_dir/h264-multitrack-subtitles-30.mkv"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$video_30" -f lavfi -i "$audio_48" -c:v libvpx -deadline realtime -cpu-used 8 -b:v 900k -c:a libvorbis -b:a 96k "$fixture_dir/vp8-vorbis.webm"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$video_30" -f lavfi -i "$audio_48" -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -row-mt 1 -b:v 900k -c:a libopus -b:a 96k "$fixture_dir/vp9-opus.webm"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$video_24" -f lavfi -i "$audio_48" -c:v libx265 -preset ultrafast -x265-params log-level=error:keyint=24 -pix_fmt yuv420p -c:a ac3 -b:a 192k "$fixture_dir/hevc-ac3.mkv"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$video_30" -f lavfi -i "$audio_48" -c:v mpeg4 -q:v 5 -c:a libmp3lame -b:a 128k "$fixture_dir/mpeg4-mp3.avi"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$video_30" -f lavfi -i "$audio_48" -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 30 -c:a aac -b:a 128k -f mpegts "$fixture_dir/h264-aac.ts"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$video_24" -f lavfi -i "$audio_48" -c:v libsvtav1 -preset 12 -crf 40 -pix_fmt yuv420p -c:a libopus -b:a 96k "$fixture_dir/av1-opus.mkv"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$video_30" -f lavfi -i "$audio_48" -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 30 -c:a flac "$fixture_dir/h264-flac.mkv"

for media in "$fixture_dir"/*; do
  ffprobe -v error -show_entries format=filename,format_name,duration,size -show_entries stream=index,codec_name,codec_type,width,height,r_frame_rate:stream_tags=language,title -of json "$media" > "$media.ffprobe.json"
done

printf 'Generated %s playable fixtures in %s\n' "$(find "$fixture_dir" -maxdepth 1 -type f ! -name '*.json' | wc -l)" "$fixture_dir"
