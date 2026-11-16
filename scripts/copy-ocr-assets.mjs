// Copies the offline OCR engine + language data into public/ocr so the app never needs the network.
// Runs automatically before `npm run dev` / `npm run build`.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const out = path.join(root, 'public', 'ocr');

const files = [
  [nm('tesseract.js', 'dist', 'worker.min.js'), 'worker.min.js'],
  // The worker picks one of these LSTM-only builds depending on CPU (relaxed SIMD / SIMD / plain).
  ...['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'].map((f) => [nm('tesseract.js-core', f), `core/${f}`]),
  [nm('@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'), 'lang/eng.traineddata.gz'],
  [nm('@tesseract.js-data', 'hin', '4.0.0_best_int', 'hin.traineddata.gz'), 'lang/hin.traineddata.gz'],
];

for (const [src, rel] of files) {
  const dst = path.join(out, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const s = fs.statSync(src);
  if (!fs.existsSync(dst) || fs.statSync(dst).size !== s.size) fs.copyFileSync(src, dst);
}
console.log('OCR assets ready in public/ocr');
