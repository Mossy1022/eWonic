// import TrackPlayer from 'react-native-track-player';
// import RNFS from 'react-native-fs';

// // WAV encoding functions (same as before)
// function convert_to_wav(frames: Uint8Array[], sampleRate: number): string {
//   let total_samples = 0;
//   frames.forEach((f) => { total_samples += f.length; });
//   const pcm_data = new Uint8Array(total_samples);
//   let offset = 0;
//   frames.forEach((f) => {
//     pcm_data.set(f, offset);
//     offset += f.length;
//   });
//   const num_channels = 1;
//   const byte_rate = sampleRate * num_channels * 2;
//   const block_align = num_channels * 2;
//   const wav_header = create_wav_header(total_samples, sampleRate, num_channels, byte_rate, block_align);
//   const wav_file = new Uint8Array(wav_header.length + pcm_data.length);
//   wav_file.set(wav_header, 0);
//   wav_file.set(pcm_data, wav_header.length);
//   let bin_str = '';
//   for (let i = 0; i < wav_file.length; i++) {
//     bin_str += String.fromCharCode(wav_file[i]);
//   }
//   return btoa(bin_str);
// }
// function create_wav_header(data_size: number, sampleRate: number, channels: number, byte_rate: number, block_align: number): Uint8Array {
//   const header = new ArrayBuffer(44);
//   const dv = new DataView(header);
//   writeString(dv, 0, 'RIFF');
//   dv.setUint32(4, 36 + data_size, true);
//   writeString(dv, 8, 'WAVE');
//   writeString(dv, 12, 'fmt ');
//   dv.setUint32(16, 16, true);
//   dv.setUint16(20, 1, true);
//   dv.setUint16(22, channels, true);
//   dv.setUint32(24, sampleRate, true);
//   dv.setUint32(28, byte_rate, true);
//   dv.setUint16(32, block_align, true);
//   dv.setUint16(34, 16, true);
//   writeString(dv, 36, 'data');
//   dv.setUint32(40, data_size, true);
//   return new Uint8Array(header);
// }
// function writeString(dv: DataView, offset: number, text: string) {
//   for (let i = 0; i < text.length; i++) {
//     dv.setUint8(offset + i, text.charCodeAt(i));
//   }
// }

// // ---- NEW: USE TRACK-PLAYER ----
// export async function play_pcm_frames(frames: Uint8Array[], sampleRate = 16000) {
//   const wav_data = convert_to_wav(frames, sampleRate);
//   const file_path = `${RNFS.CachesDirectoryPath}/temp_audio.wav`;
//   await RNFS.writeFile(file_path, wav_data, 'base64');
//   const uri = `file://${file_path}`;
//   // Reset to ensure only our wav is in queue
//   await TrackPlayer.reset();
//   await TrackPlayer.add([
//     {
//       id: 'audio',
//       url: uri,
//       title: '',
//       artist: '',
//       // You could specify type: 'default' or 'audio/wav', but not required
//     },
//   ]);
//   await TrackPlayer.play();
//   // Optionally: cleanup file after playback (or re-use)
// }