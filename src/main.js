import './styles/main.css';
import './game/engine.js';

const BUILD = '2026-06-13-mp19';
const tag = document.getElementById('appBuildTag');
if (tag) tag.textContent = `Build ${BUILD}`;
