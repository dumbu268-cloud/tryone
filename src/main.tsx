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
  void import('./dev/visualtest').then(({ runVisualTest }) => runVisualTest(imageUrl, canvas));
} else {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
