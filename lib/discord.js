// Helpers Discord : validation d'URL webhook + builders d'embed/markdown
// purs. Lazy-loadé depuis index.html via dynamic import() — la plupart
// des utilisateur·ices n'utilisent jamais les actions Discord, donc on
// évite de parser ce code au chargement initial.
//
// L'orchestration (computeOptimalAssignment, accès state, t() i18n)
// reste côté index.html — on injecte les résultats / les paramètres
// déjà calculés ici pour rester pur et testable.

import { JOB_BY_ID } from './jobs.js';

// Pattern strict : doit matcher https://discord.com/api/webhooks/<id>/<token>
// (ou discordapp.com qui est l'ancien domaine encore servi).
export const DISCORD_WEBHOOK_PATTERN = /^https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;

export function isValidWebhookUrl(url) {
  return typeof url === 'string' && DISCORD_WEBHOOK_PATTERN.test(url);
}

// Construit le payload webhook complet (avec embed riche).
// Le caller doit fournir les `fields` déjà calculés — l'orchestration
// diffère entre raid8 (3 fields tank/heal/dps) et raid24 (1 field par
// alliance), donc on laisse au front la liberté de structurer.
export function buildEmbedPayload({
  title, description, link, ogImageUrl, fields,
  color = 0x00e5ff, username = 'Party Builder'
}) {
  const embed = {
    title: String(title || '').slice(0, 256),
    url: link,
    description: String(description || '').slice(0, 2048),
    color,
    fields: Array.isArray(fields) ? fields : [],
    footer: { text: 'party-builder.pages.dev' },
    timestamp: new Date().toISOString()
  };
  if (ogImageUrl) embed.image = { url: ogImageUrl };
  return { username, embeds: [embed] };
}

// Construit le texte Markdown pour copier-coller dans Discord/Slack/etc.
// args :
//   contentLabel : label affiché du contenu (ex: "Raid 8")
//   raidWhen     : trim du champ "Quoi/Quand?" (peut être '')
//   players      : state.players (raw)
//   bannedJobs   : tableau d'ids de jobs interdits
//   link         : URL de partage du salon
//   result       : output de computeOptimalAssignment (ou { error })
//   t            : fonction i18n (caller-side)
export function buildMarkdown({
  contentLabel, raidWhen, players, bannedJobs, link, result, t
}) {
  const ROLE_LABELS = {
    tank:   '🛡️ ' + t('res_slotTank'),
    heal:   '💚 ' + t('res_slotHeal'),
    melee:  '⚔️ ' + t('res_slotMelee'),
    ranged: '🎯 ' + t('res_slotDistance'),
    caster: '🔮 ' + t('res_slotCaster')
  };
  const lines = [];
  lines.push(`**Party Builder · ${contentLabel}${raidWhen ? ' · ' + raidWhen : ''}**`);
  lines.push('');

  if (result && !result.error) {
    const byRole = { tank: [], heal: [], melee: [], ranged: [], caster: [] };
    const bench = [];
    result.results.forEach(r => {
      if (!r.assigned) { bench.push(r); return; }
      byRole[r.role].push(r);
    });
    ['tank','heal','melee','ranged','caster'].forEach(role => {
      const list = byRole[role];
      if (list.length === 0) return;
      lines.push(ROLE_LABELS[role]);
      list.forEach(r => {
        const tag = r.prefRank === 0 ? ' ★' : (r.forced ? ' ⚠️' : '');
        lines.push(`  • ${r.name} — ${r.jobName}${tag}`);
      });
    });
    if (bench.length > 0) {
      lines.push('');
      lines.push(t('dc_bench', { names: bench.map(r => r.name).join(', ') }));
    }
  } else {
    // Pas de compo possible : on liste juste le roster
    lines.push(t('dc_rosterFallback'));
    (players || [])
      .filter(p => p.name && p.name.trim() !== '' && (p.presence || 'in') !== 'out')
      .forEach(p => {
        const prefs = (p.preferences || [])
          .map(id => (JOB_BY_ID[id] || {}).name || id)
          .join(' > ') || '—';
        const tag = p.presence === 'maybe' ? ' (?)' : '';
        lines.push(`• ${p.name}${tag} : ${prefs}`);
      });
  }

  const absents = (players || []).filter(p => p.name && p.name.trim() && p.presence === 'out');
  if (absents.length > 0) {
    lines.push('');
    lines.push(t('dc_absents', { names: absents.map(p => p.name).join(', ') }));
  }

  if (Array.isArray(bannedJobs) && bannedJobs.length > 0) {
    const names = bannedJobs.map(id => (JOB_BY_ID[id] || {}).name || id).join(', ');
    lines.push(t('dc_banned', { names }));
  }

  lines.push('');
  lines.push(`🔗 ${link}`);
  return lines.join('\n');
}
