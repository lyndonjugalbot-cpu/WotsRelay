import { createRoot } from 'react-dom/client';
import '@fontsource-variable/atkinson-hyperlegible-next';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';
import { App } from './App.tsx';
import { applyTheme, savedTheme } from './components/Settings.tsx';

applyTheme(savedTheme());
createRoot(document.getElementById('root')!).render(<App />);
