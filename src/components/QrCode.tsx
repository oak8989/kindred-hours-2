import { useEffect, useRef, useState } from 'react';
import { Camera, CameraOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// Fixed version 3-L QR, byte mode, mask 0. Attendance codes are at most 53 UTF-8 bytes.
function qrMatrix(value: string) {
  const input = new TextEncoder().encode(value);
  if (input.length > 53) throw new Error('QR value is too long.');
  const bits: number[] = [0, 1, 0, 0, ...Array.from({ length: 8 }, (_, i) => (input.length >> (7 - i)) & 1)];
  for (const byte of input) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  for (let i = 0; i < Math.min(4, 440 - bits.length); i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0; words.length < 55; pad++) words.push(pad % 2 ? 0x11 : 0xec);
  const exp = Array.from({ length: 512 }, () => 0), log = Array.from({ length: 256 }, () => 0);
  for (let i = 0, x = 1; i < 255; i++) { exp[i] = x; log[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
  const mul = (a: number, b: number) => a && b ? exp[log[a] + log[b]] : 0;
  let generator = [1];
  for (let i = 0; i < 15; i++) { const next = Array(generator.length + 1).fill(0); for (let j = 0; j < generator.length; j++) { next[j] ^= generator[j]; next[j + 1] ^= mul(generator[j], exp[i]); } generator = next; }
  const work = [...words, ...Array(15).fill(0)];
  for (let i = 0; i < 55; i++) { const factor = work[i]; for (let j = 0; j < generator.length; j++) work[i + j] ^= mul(generator[j], factor); }
  const data = [...words, ...work.slice(55)];
  const size = 29;
  const grid: (boolean | null)[][] = Array.from({ length: size }, () => Array(size).fill(null));
  const put = (x: number, y: number, dark: boolean) => { if (x >= 0 && y >= 0 && x < size && y < size) grid[y][x] = dark; };
  for (const [x0, y0] of [[0, 0], [22, 0], [0, 22]]) {
    for (let y = -1; y <= 7; y++) for (let x = -1; x <= 7; x++) {
      const inside = x >= 0 && x <= 6 && y >= 0 && y <= 6;
      put(x0 + x, y0 + y, inside && (x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4)));
    }
  }
  for (let i = 8; i < size - 8; i++) { put(i, 6, i % 2 === 0); put(6, i, i % 2 === 0); }
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) put(22 + x, 22 + y, Math.max(Math.abs(x), Math.abs(y)) !== 1);
  for (let i = 0; i < 15; i++) {
    const bit = ((0x77c4 >> i) & 1) === 1;
    put(8, i < 6 ? i : i < 8 ? i + 1 : size - 15 + i, bit);
    put(i < 8 ? size - 1 - i : i === 8 ? 7 : 14 - i, 8, bit);
  }
  put(8, size - 8, true);
  let index = 0, upwards = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const y = upwards ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const x = right - dx;
        if (grid[y][x] !== null) continue;
        const bit = index < data.length * 8 ? ((data[index >> 3] >> (7 - (index & 7))) & 1) === 1 : false;
        put(x, y, bit !== ((x + y) % 2 === 0));
        index++;
      }
    }
    upwards = !upwards;
  }
  return grid;
}

export function QrCode({ value, label }: { value: string; label: string }) {
  const matrix = qrMatrix(value);
  return <div className="inline-flex flex-col items-center gap-3"><svg role="img" aria-label={label} viewBox="0 0 37 37" className="w-56 max-w-full rounded-2xl bg-white p-2 shadow-sm" shapeRendering="crispEdges"><path fill="white" d="M0 0h37v37H0z" /><path fill="#204b42" d={matrix.flatMap((row, y) => row.flatMap((dark, x) => dark ? [`M${x + 4} ${y + 4}h1v1h-1z`] : [])).join('')} /></svg><span className="max-w-60 break-all text-center font-mono text-[10px] text-[#627468]">{value}</span></div>;
}

type Detector = { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> };
export function QrScanner({ onCode }: { onCode: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const frame = useRef<number>(0);
  const [active, setActive] = useState(false);
  const [error, setError] = useState('');
  const [manual, setManual] = useState('');
  const stop = () => { cancelAnimationFrame(frame.current); stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; setActive(false); };
  useEffect(() => () => { cancelAnimationFrame(frame.current); stream.current?.getTracks().forEach(track => track.stop()); }, []);
  const start = async () => {
    const BarcodeDetector = (window as Window & { BarcodeDetector?: new (options: { formats: string[] }) => Detector }).BarcodeDetector;
    if (!BarcodeDetector) { setError('Camera QR scanning is unavailable in this browser. Enter the code shown below the QR instead.'); return; }
    try {
      const camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      stream.current = camera;
      if (!video.current) { camera.getTracks().forEach(track => track.stop()); return; }
      video.current.srcObject = camera;
      await video.current.play();
      setActive(true); setError('');
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const scan = async () => {
        if (!stream.current || !video.current) return;
        try { const codes = await detector.detect(video.current); if (codes[0]?.rawValue) { stop(); onCode(codes[0].rawValue); return; } } catch { /* Keep scanning if a frame is unreadable. */ }
        frame.current = requestAnimationFrame(scan);
      };
      frame.current = requestAnimationFrame(scan);
    } catch { setError('Camera permission was denied or no camera is available. Enter the code manually.'); stop(); }
  };
  return <div className="space-y-3"><div className="flex items-center gap-3"><Button type="button" variant="outline" className="rounded-full" onClick={() => active ? stop() : void start()}>{active ? <CameraOff size={17} className="mr-2" /> : <Camera size={17} className="mr-2" />}{active ? 'Stop camera' : 'Scan QR code'}</Button><span className="text-xs text-[#627468]">HTTPS or localhost required</span></div><video ref={video} className={active ? 'max-h-64 w-full rounded-2xl bg-forest object-cover' : 'hidden'} muted playsInline aria-label="Camera QR scanner" />{error && <p role="alert" className="text-sm text-[#a33c32]">{error}</p>}<form className="flex gap-2" onSubmit={event => { event.preventDefault(); onCode(manual.trim()); setManual(''); }}><Input aria-label="QR attendance code" value={manual} onChange={event => setManual(event.target.value)} placeholder="Or enter the short code" required autoComplete="off" className="rounded-xl" /><Button type="submit" className="rounded-xl bg-forest text-white">Use code</Button></form></div>;
}
