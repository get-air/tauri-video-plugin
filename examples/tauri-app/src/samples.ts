export interface DemoSource {
  title: string
  film: string
  format: string
  video: string
  audio: string
  size: string
  uri: string
  note: string
}

export const DEMO_SOURCES: readonly DemoSource[] = [
  {
    title: 'Sintel · MP4',
    film: 'Sintel trailer',
    format: 'MP4',
    video: 'H.264',
    audio: 'AAC',
    size: '4.2 MB',
    uri: 'https://media.w3.org/2010/05/sintel/trailer.mp4',
    note: 'Fast baseline check',
  },
  {
    title: 'Sintel · WebM',
    film: 'Sintel trailer',
    format: 'WebM',
    video: 'VP8',
    audio: 'Vorbis',
    size: '3.0 MB',
    uri: 'https://media.w3.org/2010/05/sintel/trailer.webm',
    note: 'Open web container',
  },
  {
    title: 'Sintel · Ogg',
    film: 'Sintel trailer',
    format: 'Ogg',
    video: 'Theora',
    audio: 'Vorbis',
    size: '12.4 MB',
    uri: 'https://media.w3.org/2010/05/sintel/trailer.ogv',
    note: 'Legacy compatibility',
  },
  {
    title: 'Sintel · MKV 1080p',
    film: 'Sintel full film',
    format: 'MKV',
    video: 'H.264',
    audio: '5.1 surround',
    size: '1.1 GB',
    uri: 'https://download.blender.org/durian/movies/Sintel.2010.1080p.mkv',
    note: 'HTTPS range streaming',
  },
]

export const DEFAULT_SOURCE = DEMO_SOURCES[0]
