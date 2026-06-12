import './styles/main.css';
import {
  startGameFromLobby, boardStats, previewBoard, registerPlayAgainHandler,
} from './game/engine.js';
import { initLobby, playAgainAfterGame } from './ui/lobby.js';

registerPlayAgainHandler(playAgainAfterGame);
initLobby(startGameFromLobby, boardStats, previewBoard);

const BUILD = '2026-06-13-mp21';
const tag = document.getElementById('appBuildTag');
if (tag) tag.textContent = `Build ${BUILD}`;
