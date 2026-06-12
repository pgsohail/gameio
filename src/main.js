import './styles/main.css';
import './game/engine.js';

const BUILD = '2026-06-13-mp3';
const tag = document.getElementById('appBuildTag');
if (tag) tag.textContent = `Build ${BUILD}`;
