// FileCard-style attachment presentation model, ported from Ant Design X
// (https://x.ant.design/components/file-card). Meldwork's renderer is Vue, so
// the component library design is ported rather than installed: preset file
// icons, extension grouping, and the generation-loading semantics all mirror
// the upstream FileCard behavior.

export const FILE_CARD_IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'jfif']
export const FILE_CARD_AUDIO_EXT = ['mp3', 'wav', 'flac', 'ape', 'aac', 'ogg', 'm4a']
export const FILE_CARD_VIDEO_EXT = ['mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm']

// SVG path data ported from @ant-design/icons (filled file glyphs) and
// Ant Design X file-card icons (audio/video glyphs).
const FILE_CARD_ICON_ART = Object.freeze({
  excel: {
    viewBox: '0 0 1024 1024',
    paths: [
      'M854.6 288.7c6 6 9.4 14.1 9.4 22.6V928c0 17.7-14.3 32-32 32H192c-17.7 0-32-14.3-32-32V96c0-17.7 14.3-32 32-32h424.7c8.5 0 16.7 3.4 22.7 9.4l215.2 215.3zM790.2 326L602 137.8V326h188.2zM575.34 477.84l-61.22 102.3L452.3 477.8a12 12 0 0 0-10.27-5.79h-38.44a12 12 0 0 0-6.4 1.85 12 12 0 0 0-3.75 16.56l82.34 130.42-83.45 132.78a12 12 0 0 0-1.84 6.39 12 12 0 0 0 12 12h34.46a12 12 0 0 0 10.21-5.7l62.7-101.47 62.3 101.45a12 12 0 0 0 10.23 5.72h37.48a12 12 0 0 0 6.48-1.9 12 12 0 0 0 3.62-16.58l-83.83-130.55 85.3-132.47a12 12 0 0 0 1.9-6.5 12 12 0 0 0-12-12h-35.7a12 12 0 0 0-10.29 5.84z',
    ],
  },
  image: {
    viewBox: '0 0 1024 1024',
    paths: [
      'M854.6 288.7L639.4 73.4c-6-6-14.2-9.4-22.7-9.4H192c-17.7 0-32 14.3-32 32v832c0 17.7 14.3 32 32 32h640c17.7 0 32-14.3 32-32V311.3c0-8.5-3.4-16.6-9.4-22.6zM400 402c22.1 0 40 17.9 40 40s-17.9 40-40 40-40-17.9-40-40 17.9-40 40-40zm296 294H328c-6.7 0-10.4-7.7-6.3-12.9l99.8-127.2a8 8 0 0 1 12.6 0l41.1 52.4 77.8-99.2a8 8 0 0 1 12.6 0l136.5 174c4.3 5.2.5 12.9-6.1 12.9zm-94-370V137.8L790.2 326H602z',
    ],
  },
  markdown: {
    viewBox: '0 0 1024 1024',
    paths: [
      'M854.6 288.7c6 6 9.4 14.1 9.4 22.6V928c0 17.7-14.3 32-32 32H192c-17.7 0-32-14.3-32-32V96c0-17.7 14.3-32 32-32h424.7c8.5 0 16.7 3.4 22.7 9.4l215.2 215.3zM790.2 326L602 137.8V326h188.2zM426.13 600.93l59.11 132.97a16 16 0 0 0 14.62 9.5h24.06a16 16 0 0 0 14.63-9.51l59.1-133.35V758a16 16 0 0 0 16.01 16H641a16 16 0 0 0 16-16V486a16 16 0 0 0-16-16h-34.75a16 16 0 0 0-14.67 9.62L512.1 662.2l-79.48-182.59a16 16 0 0 0-14.67-9.61H383a16 16 0 0 0-16 16v272a16 16 0 0 0 16 16h27.13a16 16 0 0 0 16-16V600.93z',
    ],
  },
  pdf: {
    viewBox: '0 0 1024 1024',
    paths: [
      'M854.6 288.7c6 6 9.4 14.1 9.4 22.6V928c0 17.7-14.3 32-32 32H192c-17.7 0-32-14.3-32-32V96c0-17.7 14.3-32 32-32h424.7c8.5 0 16.7 3.4 22.7 9.4l215.2 215.3zM790.2 326L602 137.8V326h188.2zM633.22 637.26c-15.18-.5-31.32.67-49.65 2.96-24.3-14.99-40.66-35.58-52.28-65.83l1.07-4.38 1.24-5.18c4.3-18.13 6.61-31.36 7.3-44.7.52-10.07-.04-19.36-1.83-27.97-3.3-18.59-16.45-29.46-33.02-30.13-15.45-.63-29.65 8-33.28 21.37-5.91 21.62-2.45 50.07 10.08 98.59-15.96 38.05-37.05 82.66-51.2 107.54-18.89 9.74-33.6 18.6-45.96 28.42-16.3 12.97-26.48 26.3-29.28 40.3-1.36 6.49.69 14.97 5.36 21.92 5.3 7.88 13.28 13 22.85 13.74 24.15 1.87 53.83-23.03 86.6-79.26 3.29-1.1 6.77-2.26 11.02-3.7l11.9-4.02c7.53-2.54 12.99-4.36 18.39-6.11 23.4-7.62 41.1-12.43 57.2-15.17 27.98 14.98 60.32 24.8 82.1 24.8 17.98 0 30.13-9.32 34.52-23.99 3.85-12.88.8-27.82-7.48-36.08-8.56-8.41-24.3-12.43-45.65-13.12zM385.23 765.68v-.36l.13-.34a54.86 54.86 0 0 1 5.6-10.76c4.28-6.58 10.17-13.5 17.47-20.87 3.92-3.95 8-7.8 12.79-12.12 1.07-.96 7.91-7.05 9.19-8.25l11.17-10.4-8.12 12.93c-12.32 19.64-23.46 33.78-33 43-3.51 3.4-6.6 5.9-9.1 7.51a16.43 16.43 0 0 1-2.61 1.42c-.41.17-.77.27-1.13.3a2.2 2.2 0 0 1-1.12-.15 2.07 2.07 0 0 1-1.27-1.91zM511.17 547.4l-2.26 4-1.4-4.38c-3.1-9.83-5.38-24.64-6.01-38-.72-15.2.49-24.32 5.29-24.32 6.74 0 9.83 10.8 10.07 27.05.22 14.28-2.03 29.14-5.7 35.65zm-5.81 58.46l1.53-4.05 2.09 3.8c11.69 21.24 26.86 38.96 43.54 51.31l3.6 2.66-4.39.9c-16.33 3.38-31.54 8.46-52.34 16.85 2.17-.88-21.62 8.86-27.64 11.17l-5.25 2.01 2.8-4.88c12.35-21.5 23.76-47.32 36.05-79.77zm157.62 76.26c-7.86 3.1-24.78.33-54.57-12.39l-7.56-3.22 8.2-.6c23.3-1.73 39.8-.45 49.42 3.07 4.1 1.5 6.83 3.39 8.04 5.55a4.64 4.64 0 0 1-1.36 6.31 6.7 6.7 0 0 1-2.17 1.28z',
    ],
  },
  ppt: {
    viewBox: '0 0 1024 1024',
    paths: [
      'M854.6 288.7c6 6 9.4 14.1 9.4 22.6V928c0 17.7-14.3 32-32 32H192c-17.7 0-32-14.3-32-32V96c0-17.7 14.3-32 32-32h424.7c8.5 0 16.7 3.4 22.7 9.4l215.2 215.3zM790.2 326L602 137.8V326h188.2zM468.53 760v-91.54h59.27c60.57 0 100.2-39.65 100.2-98.12 0-58.22-39.58-98.34-99.98-98.34H424a12 12 0 0 0-12 12v276a12 12 0 0 0 12 12h32.53a12 12 0 0 0 12-12zm0-139.33h34.9c47.82 0 67.19-12.93 67.19-50.33 0-32.05-18.12-50.12-49.87-50.12h-52.22v100.45z',
    ],
  },
  word: {
    viewBox: '0 0 1024 1024',
    paths: [
      'M854.6 288.7c6 6 9.4 14.1 9.4 22.6V928c0 17.7-14.3 32-32 32H192c-17.7 0-32-14.3-32-32V96c0-17.7 14.3-32 32-32h424.7c8.5 0 16.7 3.4 22.7 9.4l215.2 215.3zM790.2 326L602 137.8V326h188.2zM512 566.1l52.81 197a12 12 0 0 0 11.6 8.9h31.77a12 12 0 0 0 11.6-8.88l74.37-276a12 12 0 0 0 .4-3.12 12 12 0 0 0-12-12h-35.57a12 12 0 0 0-11.7 9.31l-45.78 199.1-49.76-199.32A12 12 0 0 0 528.1 472h-32.2a12 12 0 0 0-11.64 9.1L434.6 680.01 388.5 481.3a12 12 0 0 0-11.68-9.29h-35.39a12 12 0 0 0-3.11.41 12 12 0 0 0-8.47 14.7l74.17 276A12 12 0 0 0 415.6 772h31.99a12 12 0 0 0 11.59-8.9l52.81-197z',
    ],
  },
  zip: {
    viewBox: '0 0 1024 1024',
    paths: [
      'M854.6 288.7c6 6 9.4 14.1 9.4 22.6V928c0 17.7-14.3 32-32 32H192c-17.7 0-32-14.3-32-32V96c0-17.7 14.3-32 32-32h424.7c8.5 0 16.7 3.4 22.7 9.4l215.2 215.3zM790.2 326L602 137.8V326h188.2zM296 136v64h64v-64h-64zm64 64v64h64v-64h-64zm-64 64v64h64v-64h-64zm64 64v64h64v-64h-64zm-64 64v64h64v-64h-64zm64 64v64h64v-64h-64zm-64 64v64h64v-64h-64zm0 64v160h128V584H296zm48 48h32v64h-32v-64z',
    ],
  },
  default: {
    viewBox: '0 0 1024 1024',
    paths: [
      'M854.6 288.7c6 6 9.4 14.1 9.4 22.6V928c0 17.7-14.3 32-32 32H192c-17.7 0-32-14.3-32-32V96c0-17.7 14.3-32 32-32h424.7c8.5 0 16.7 3.4 22.7 9.4l215.2 215.3zM790.2 326L602 137.8V326h188.2zM320 482a8 8 0 0 0-8 8v48a8 8 0 0 0 8 8h384a8 8 0 0 0 8-8v-48a8 8 0 0 0-8-8H320zm0 136a8 8 0 0 0-8 8v48a8 8 0 0 0 8 8h184a8 8 0 0 0 8-8v-48a8 8 0 0 0-8-8H320z',
    ],
  },
  java: {
    viewBox: '0 0 1024 1024',
    paths: [
      'M212.68 692.99s-34.325 19.95 24.343 26.6c71.1 8.05 107.351 7 185.632-7.874 0 0 20.665 12.949 49.385 24.149-175.475 75.074-397.184-4.375-259.36-42.875m-21.366-98.173s-38.352 28.35 20.315 34.475c75.83 7.875 135.897 8.4 239.571-11.55 0 0 14.36 14.525 36.952 22.4-212.427 62.123-448.846 5.075-296.838-45.325m180.73-166.422c43.256 49.699-11.384 94.498-11.384 94.498s109.804-56.7 59.368-127.573c-47.11-66.15-83.185-99.049 112.255-212.273.175 0-306.819 76.65-160.24 245.348M604.26 765.439s25.393 20.825-27.846 37.1c-101.397 30.625-421.7 39.9-510.664 1.225-32.048-13.825 28.02-33.25 46.934-37.275 19.613-4.2 30.997-3.5 30.997-3.5-35.551-25.025-229.94 49.175-98.771 70.35 357.605 58.1 652.165-26.075 559.35-67.9M229.142 493.144S66.1 531.818 171.35 545.818c44.482 5.95 133.095 4.55 215.58-2.275 67.423-5.6 135.196-17.85 135.196-17.85s-23.818 10.15-40.98 21.875C315.653 591.143-3.95 570.843 87.99 526.393c77.93-37.45 141.151-33.25 141.151-33.25M521.6 656.416c168.296-87.324 90.365-171.322 36.077-159.948-13.31 2.8-19.264 5.25-19.264 5.25s4.903-7.7 14.36-11.025c107.351-37.8 190.01 111.299-34.675 170.273 0-.175 2.627-2.45 3.502-4.55M420.028 0s93.166 93.1-88.438 236.246c-145.53 114.8-33.274 180.424 0 255.148-84.936-76.65-147.28-144.024-105.425-206.848C287.634 192.672 457.68 147.873 420.028 0m-174.25 893.188c161.466 10.325 409.443-5.775 415.222-82.075 0 0-11.208 28.875-133.445 51.975-137.824 25.9-307.87 22.925-408.567 6.3 0-.175 20.665 16.975 126.79 23.8',
    ],
  },
  javascript: {
    viewBox: '0 0 1024 1024',
    paths: [
      'M353 16H192.545v425.615c0 105.313-36.166 134.718-99.104 134.718-29.494 0-56.055-5.05-76.718-12.144L0 688.784C29.484 698.924 74.73 705 110.126 705 254.631 705 353 637.16 353 442.658zM702.49 0C547.26 0 449 88.126 449 204.609c0 100.313 75.67 163.12 185.696 203.629 79.577 28.358 111.03 53.695 111.03 95.218 0 45.579-36.358 74.96-105.13 74.96-63.868 0-121.849-21.311-161.146-42.573v-.042L449 662.427C486.361 683.735 556.12 705 631.741 705 813.52 705 898 607.753 898 493.293c0-97.243-54.036-160.035-170.937-204.627-86.47-34.432-122.813-53.669-122.813-97.227 0-34.45 31.446-65.834 96.3-65.834 63.834 0 107.728 21.445 133.307 34.632L872.193 32.05C832.103 14.461 778.109 0 702.49 0',
    ],
  },
  python: {
    viewBox: '0 0 1024 1024',
    paths: [
      'M443 678.5c0 15.74 12.76 28.5 28.5 28.5s28.5-12.76 28.5-28.5-12.76-28.5-28.5-28.5-28.5 12.76-28.5 28.5M300 121.5c0 15.74 12.76 28.5 28.5 28.5s28.5-12.76 28.5-28.5S344.24 93 328.5 93 300 105.76 300 121.5',
      'M709.524 185.714h-95.238V90.476C614.286 40.571 573.714 0 523.81 0H276.19c-49.904 0-90.476 40.571-90.476 90.476v95.238H90.476C40.571 185.714 0 226.286 0 276.19v247.62c0 49.904 40.571 90.476 90.476 90.476h95.238v95.238c0 49.905 40.572 90.476 90.476 90.476h247.62c49.904 0 90.476-40.571 90.476-90.476v-95.238h95.238c49.905 0 90.476-40.572 90.476-90.476V276.19c0-49.904-40.571-90.476-90.476-90.476M90.476 557.143c-18.38 0-33.333-14.953-33.333-33.333V276.19c0-18.38 14.952-33.333 33.333-33.333h278.572c15.81 0 28.571-12.762 28.571-28.571 0-15.81-12.762-28.572-28.571-28.572h-126.19V90.476c0-18.38 14.952-33.333 33.332-33.333h247.62c18.38 0 33.333 14.952 33.333 33.333v256.476c0 13.524-10.953 24.477-24.476 24.477H267.333c-45.047 0-81.619 36.666-81.619 81.619v104.095zm652.381-33.333c0 18.38-14.952 33.333-33.333 33.333H430.952c-15.81 0-28.571 12.762-28.571 28.571 0 15.81 12.762 28.572 28.571 28.572h126.19v95.238c0 18.38-14.952 33.333-33.332 33.333H276.19c-18.38 0-33.333-14.952-33.333-33.333V453.048c0-13.524 10.953-24.477 24.476-24.477h265.334c45.047 0 81.619-36.666 81.619-81.619V242.857h95.238c18.38 0 33.333 14.953 33.333 33.333z',
    ],
  },
  audio: {
    viewBox: '0 0 16 16',
    paths: [
      'M14.1178571,4.0125 C14.225,4.11964286 14.2857143,4.26428571 14.2857143,4.41607143 L14.2857143,15.4285714 C14.2857143,15.7446429 14.0303571,16 13.7142857,16 L2.28571429,16 C1.96964286,16 1.71428571,15.7446429 1.71428571,15.4285714 L1.71428571,0.571428571 C1.71428571,0.255357143 1.96964286,0 2.28571429,0 L9.86964286,0 C10.0214286,0 10.1678571,0.0607142857 10.275,0.167857143 L14.1178571,4.0125 Z M10.7315824,7.11216117 C10.7428131,7.15148751 10.7485063,7.19218979 10.7485063,7.23309113 L10.7485063,8.07742614 C10.7484199,8.27364959 10.6183424,8.44607275 10.4296853,8.50003683 L8.32984514,9.09986306 L8.32984514,11.7071803 C8.32986605,12.5367078 7.67249692,13.217028 6.84345686,13.2454634 L6.79068592,13.2463395 C6.12766108,13.2463395 5.53916361,12.8217001 5.33010655,12.1924966 C5.1210495,11.563293 5.33842118,10.8709227 5.86959669,10.4741173 C6.40077221,10.0773119 7.12636292,10.0652587 7.67042486,10.4442027 L7.67020842,7.74937024 L7.68449368,7.74937024 C7.72405122,7.59919041 7.83988806,7.48101083 7.98924584,7.4384546 L10.1880418,6.81004755 C10.42156,6.74340323 10.6648954,6.87865515 10.7315824,7.11216117 Z M9.60714286,1.31785714 L12.9678571,4.67857143 L9.60714286,4.67857143 L9.60714286,1.31785714 Z',
    ],
  },
  video: {
    viewBox: '0 0 16 16',
    paths: [
      'M14.1178571,4.0125 C14.225,4.11964286 14.2857143,4.26428571 14.2857143,4.41607143 L14.2857143,15.4285714 C14.2857143,15.7446429 14.0303571,16 13.7142857,16 L2.28571429,16 C1.96964286,16 1.71428571,15.7446429 1.71428571,15.4285714 L1.71428571,0.571428571 C1.71428571,0.255357143 1.96964286,0 2.28571429,0 L9.86964286,0 C10.0214286,0 10.1678571,0.0607142857 10.275,0.167857143 L14.1178571,4.0125 Z M12.9678571,4.67857143 L9.60714286,1.31785714 L9.60714286,4.67857143 L12.9678571,4.67857143 Z M10.5379461,10.3101106 L6.68957555,13.0059749 C6.59910784,13.0693494 6.47439406,13.0473861 6.41101953,12.9569184 C6.3874624,12.9232903 6.37482581,12.8832269 6.37482581,12.8421686 L6.37482581,7.45043999 C6.37482581,7.33998304 6.46436886,7.25043999 6.57482581,7.25043999 C6.61588409,7.25043999 6.65594753,7.26307658 6.68957555,7.28663371 L10.5379461,9.98249803 C10.6284138,10.0458726 10.6503772,10.1705863 10.5870027,10.2610541 C10.5736331,10.2801392 10.5570312,10.2967411 10.5379461,10.3101106 Z',
    ],
  },
})

// Mirrors PRESET_FILE_ICONS in Ant Design X FileCard, including upstream icon
// colors. Meldwork adds a few office-format extensions (ods/odp/odt/csv, iWork)
// to the matching semantic group so every supported attachment gets a colored
// glyph instead of the generic fallback.
export const FILE_CARD_PRESETS = Object.freeze([
  { key: 'excel', color: '#22b35e', ext: ['xlsx', 'xls', 'ods', 'csv', 'numbers'] },
  { key: 'image', color: '#8c8c8c', ext: FILE_CARD_IMAGE_EXT },
  { key: 'markdown', color: '#8c8c8c', ext: ['md', 'mdx'] },
  { key: 'pdf', color: '#ff4d4f', ext: ['pdf'] },
  { key: 'ppt', color: '#ff6e31', ext: ['ppt', 'pptx', 'odp', 'key'] },
  { key: 'word', color: '#1677ff', ext: ['doc', 'docx', 'odt', 'rtf', 'pages'] },
  { key: 'zip', color: '#fab714', ext: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz'] },
  { key: 'video', color: '#ff4d4f', ext: FILE_CARD_VIDEO_EXT },
  { key: 'audio', color: '#ff6e31', ext: FILE_CARD_AUDIO_EXT },
  { key: 'java', color: '#1677ff', ext: ['java'] },
  { key: 'javascript', color: '#fab714', ext: ['js', 'mjs', 'cjs', 'jsx'] },
  { key: 'python', color: '#fab714', ext: ['py', 'pyi'] },
])

export const FILE_CARD_DEFAULT = Object.freeze({ key: 'default', color: '#8c8c8c' })

export function fileCardExtension(name) {
  const value = String(name || '')
  const match = value.match(/\.([^.]+)$/)
  return match ? match[1].toLowerCase() : ''
}

export function fileCardIconArt(key) {
  return FILE_CARD_ICON_ART[key] || FILE_CARD_ICON_ART.default
}

export function fileCardIconKey({ name = '', mimeType = '', kind = '' } = {}) {
  const mediaKind = String(kind || '').toLowerCase()
  if (['image', 'audio', 'video'].includes(mediaKind)) return mediaKind
  const extension = fileCardExtension(name)
  if (!extension) {
    const mime = String(mimeType || '').toLowerCase()
    if (mime.startsWith('image/')) return 'image'
    if (mime.startsWith('audio/')) return 'audio'
    if (mime.startsWith('video/')) return 'video'
    return FILE_CARD_DEFAULT.key
  }
  for (const preset of FILE_CARD_PRESETS) {
    if (preset.ext.includes(extension)) return preset.key
  }
  return FILE_CARD_DEFAULT.key
}

export function fileCardIconColor(key) {
  const preset = FILE_CARD_PRESETS.find(item => item.key === key)
  return preset?.color || FILE_CARD_DEFAULT.color
}

export function formatFileCardSize(bytes) {
  const size = Math.max(0, Number(bytes) || 0)
  if (size < 1024) return `${Math.round(size)} B`
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  if (size < 1024 * 1024 * 1024) {
    const mb = (size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)
    return `${Number(mb)} MB`
  }
  return `${Number((size / (1024 * 1024 * 1024)).toFixed(1))} GB`
}

// --- Media generation process state ---------------------------------------
// Agent runtimes emit trace events titled `${type}_generation` while a media
// skill or tool is in flight. The UI only needs start/complete
// semantics: progress percentages carried in event summaries are intentionally
// ignored so the surface stays stable across providers.

// The Agent runtime emits one trace event per state change while a media skill
// or tool is in flight:
//   { id, type: 'tool_start' | 'tool_result_summary',
//     status: 'running' | 'completed' | 'failed', title: '<type>_generation', summary }
// `running` summaries may contain tool progress text. The UI deliberately
// renders only start/complete semantics and never the summary, so no progress
// number ever reaches the surface.
const MEDIA_GENERATION_TITLE = /^(image|audio|video)[_-]generation$/i
const MEDIA_GENERATION_ACTIVE = new Set([
  '', 'queued', 'pending', 'planned', 'running', 'in_progress', 'streaming', 'waiting', 'processing',
])
const MEDIA_GENERATION_COMPLETE = new Set(['completed', 'complete', 'succeeded', 'success', 'done', 'finished'])

// Returns the most recent generation activity for a run, or null when there is
// nothing to surface. `phase` is 'running' or 'complete'; failures are dropped
// so a broken generation never leaves a stuck card on screen.
export function mediaGenerationFromRunEvents(events) {
  const values = Array.isArray(events) ? events : []
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const event = values[index]
    const match = MEDIA_GENERATION_TITLE.exec(String(event?.title || '').trim())
    if (!match) continue
    const type = match[1].toLowerCase()
    const status = String(event?.status || '').trim().toLowerCase()
    if (MEDIA_GENERATION_ACTIVE.has(status)) return { type, status: 'running', phase: 'running' }
    if (MEDIA_GENERATION_COMPLETE.has(status)) return { type, status: 'completed', phase: 'complete' }
    return null
  }
  return null
}

// Agent-run statuses that mean the run is over, so its generation card should
// no longer be surfaced.
const RUN_TERMINAL_STATUSES = new Set([
  'completed', 'succeeded', 'failed', 'cancelled', 'stopped', 'partial', 'timeout', 'interrupted', 'error',
])

export function activeMediaGenerationForRun(agentRuns) {
  const runs = Array.isArray(agentRuns) ? agentRuns : []
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const agent = runs[index]
    if (RUN_TERMINAL_STATUSES.has(String(agent?.status || '').trim().toLowerCase())) continue
    const activity = mediaGenerationFromRunEvents(agent?.events)
    if (activity) return { ...activity, agentKind: String(agent?.kind || '') }
  }
  return null
}
