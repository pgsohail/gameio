/** Community links — set VITE_DISCORD_INVITE_URL in .env for your server invite. */
export const DISCORD_INVITE_URL = (
  import.meta.env.VITE_DISCORD_INVITE_URL || 'https://discord.gg/buildupio'
).trim();
