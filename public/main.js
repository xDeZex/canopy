import { startApp } from './app.js';
const variant = new URLSearchParams(location.search).get('variant');
if (['A', 'B', 'C'].includes(variant)) {
  const config = await fetch('/api/prototype-comments').then((response) => response.json());
  if (config.enabled) {
    const { startCommentPrototype } = await import('./prototype-comments.js');
    await startCommentPrototype(startApp);
  } else startApp();
} else startApp();
