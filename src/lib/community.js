/** Community links — set VITE_DISCORD_INVITE_URL in .env for your server invite. */
export const DISCORD_INVITE_URL = (
  import.meta.env.VITE_DISCORD_INVITE_URL || 'https://discord.gg/buildupio'
).trim();

/** Wire every `[data-discord-link]` anchor to the Discord invite URL. */
export function wireDiscordLinks() {
  if (!DISCORD_INVITE_URL) return;
  document.querySelectorAll('[data-discord-link]').forEach(el => {
    el.href = DISCORD_INVITE_URL;
  });
}
