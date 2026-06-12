/* Bot module entry — shared core + standard personalities + mastermind. */

export { initBots, assignBotBrains, PERSONALITIES, registerPersonality, _engine } from './botCore.js';
export {
  botShouldBuy, botNextBid, botJailDecision, botRunBuildPhase,
  botEvaluateTrade, botBestProposal, botMaybeProposeTrade,
  registerStandardBots,
} from './standardBots.js';

import { registerStandardBots } from './standardBots.js';

registerStandardBots();
