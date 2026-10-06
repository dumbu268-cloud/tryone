import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

const params = new URLSearchParams(window.location.search);
if (params.has('selftest')) {
  // Dev/e2e path: run the perception+fitting self-test against a still image.
  const imageUrl = params.get('img') ?? '/test/person.jpg';
  void import('./dev/selftest').then(({ runSelfTest }) => runSelfTest(imageUrl));
  rootEl.innerHTML =
    '<div style="padding:16px;font-family:monospace;color:#9aa">Running self-test…</div>';
} else if (params.has('visualtest')) {
  // Dev/e2e path: composite the garment onto a still image for screenshot review.
  const imageUrl = params.get('img') ?? '/test/person.jpg';
  const canvas = document.createElement('canvas');
  canvas.id = 'visual-canvas';
  canvas.style.maxWidth = '100%';
  rootEl.appendChild(canvas);
  const garmentId = params.get('garment') ?? undefined;
  const cropFrac = params.has('crop') ? Number(params.get('crop')) || 1 : 1;
  void import('./dev/visualtest').then(({ runVisualTest }) =>
    runVisualTest(imageUrl, canvas, garmentId, cropFrac),
  );
} else if (params.has('replay')) {
  // Dev/e2e path: replay a real recorded video through the live pipeline.
  const canvas = document.createElement('canvas');
  canvas.id = 'visual-canvas';
  rootEl.appendChild(canvas);
  void import('./dev/replaytest').then(({ installReplay }) => installReplay(canvas));
} else if (params.has('mlprep')) {
  // Dev/e2e path: ML garment extraction, cutout drawn over a checkerboard.
  const imageUrl = params.get('img') ?? '/test/person.jpg';
  const canvas = document.createElement('canvas');
  canvas.id = 'visual-canvas';
  canvas.style.maxWidth = '100%';
  rootEl.appendChild(canvas);
  void import('./dev/mlpreptest').then(({ runMlPrepTest }) => runMlPrepTest(imageUrl, canvas));
} else if (params.has('preptest')) {
  // Dev/e2e path: auto-prepare a garment image, then wear it on a person image.
  const garmentUrl = params.get('garment') ?? '/garments/samples/sample-longsleeve.svg';
  const personUrl = params.get('img') ?? '/test/person.jpg';
  const canvas = document.createElement('canvas');
  canvas.id = 'visual-canvas';
  canvas.style.maxWidth = '100%';
  rootEl.appendChild(canvas);
  const useMl = params.has('ml');
  void import('./dev/preptest').then(({ runPrepTest }) =>
    runPrepTest(garmentUrl, personUrl, canvas, useMl),
  );
} else {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
