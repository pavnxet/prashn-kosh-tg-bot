'use strict';

/**
 * messages.js — every user-facing string, in one place, so language can be
 * switched later without touching logic.
 *
 * Formatting is **HTML** (`PARSE_MODE`), *not* Markdown. Telegram's legacy
 * Markdown treats every stray `_` or `*` as an entity delimiter and rejects the
 * entire message with `400 can't parse entities: Can't find end of the entity`.
 * A `<chat_id>` placeholder in the help text was enough to break `/help` in
 * production, and a channel titled `My_Channel` would have broken `/connect`.
 *
 * HTML has the same failure mode with `<` and `&`, so the rule here is:
 *   - templates may contain only tags Telegram supports (`<b>`, `<code>`, …);
 *   - `t()` **escapes every interpolated value**, so data (titles, error text,
 *     ids) can never open a tag or entity.
 * `tests/messages.test.js` validates every rendered string against those rules.
 */

const DEFAULT_LANG = 'en';
const LANGUAGES = Object.freeze(['en', 'hi']);

/** Passed straight to the Bot API as `parse_mode`. */
const PARSE_MODE = 'HTML';

const STRINGS = Object.freeze({
  en: {
    welcome: '👋 <b>Prashn-Kosh Bot</b>\nI post previous-year questions to your channels on a schedule.',
    not_authorised: '⛔ You are not authorised to use this bot.',
    help: [
      '📖 <b>Commands</b>',
      '/start — this message',
      '/id — show your Telegram ids (use this to get <code>OWNER_TG_ID</code>)',
      '/status — bot status and configuration summary',
      '/connect &lt;chat_id&gt; — verify and connect a channel',
      '/channels — list connected channels',
      '/pause &lt;chat_id&gt; · /resume &lt;chat_id&gt; — toggle a channel',
      '/admins — list bot admins',
      '/preview [count] — see questions here in this chat (nothing is posted)',
      '/sendnow [count] — post questions to a connected channel right now',
      '/schedule — daily posting times (add · list · enable · disable)',
      '',
      'Add the bot to a channel as an administrator with <b>Post messages</b>, then send',
      '<code>/connect -100…</code> here with that channel id.'
    ].join('\n'),
    id_info: [
      '🆔 <b>Your ids</b>',
      'User id: <code>{userId}</code>',
      'Chat id: <code>{chatId}</code>'
    ].join('\n'),
    status: [
      '⚙️ <b>Status</b>',
      'Bot: <code>@{username}</code>',
      'Phase: <code>{phase}</code>',
      'Dry run: <code>{dryRun}</code>',
      'Timezone: <code>{timezone}</code>',
      'Database: <code>{dbHost}</code>',
      'Owner set: <code>{ownerSet}</code>',
      'Channels: <code>{channels}</code>',
      'Admins: <code>{admins}</code>'
    ].join('\n'),
    connect_usage: 'ℹ️ Usage: <code>/connect -1001234567890</code>\nAdd the bot to the channel as an admin with <b>Post messages</b> first.',
    connect_ok: '✅ Connected <b>{title}</b> (<code>{chatId}</code>).\nPosting rights: <code>{reason}</code>.',
    connect_failed: '❌ Could not connect <code>{chatId}</code>: <b>{error}</b>',
    connect_invalid: '❌ <code>{chatId}</code> is not a valid chat id: {error}',
    connect_hint: '\n\nAdd me to the channel as an administrator with <b>Post messages</b>, then retry.',
    channels_empty: '📭 No channels connected yet. Use <code>/connect -100…</code>.',
    channels_header: '📢 <b>Connected channels</b>',
    channels_row: '{marker} <code>{chatId}</code> — {title} ({tz})',
    channel_toggled: '✅ Channel <code>{chatId}</code> is now {state}.',
    channel_unknown: '❌ No channel found with id <code>{chatId}</code>.',
    admins_header: '👥 <b>Admins</b>',
    admins_owner: '👑 <code>{userId}</code> — owner (from <code>OWNER_TG_ID</code>)',
    admins_row: '• <code>{userId}</code> — {role}',
    admins_none: '<i>(no extra admins)</i>',
    unknown_command: '🤔 Unknown command. Send /help for the list.',
    error_generic: '💥 Something went wrong: {error}',

    // --- Phase 3: sending -------------------------------------------------
    preview_usage: 'ℹ️ Usage: <code>/preview [count]</code>\nShows you a sample here — nothing is posted to a channel.',
    preview_header: '👀 <b>Preview</b> — {count} item(s), sent to you only. Nothing was posted to a channel.',
    preview_none: '📭 No eligible questions were found.',
    preview_header_note: 'ℹ️ These mirror the channel’s history, so “already sent” is accurate.',
    sendnow_usage:
      'ℹ️ Usage: <code>/sendnow [count] [chat_id]</code>\n' +
      'Posts questions to a connected channel right now.\n' +
      'Add <code>text</code> to force the text format.',
    sendnow_no_channel: '❌ No active channel is connected. Use <code>/connect -100…</code> first.',
    sendnow_none: '📭 No eligible questions were found for <b>{title}</b>.',
    sendnow_start: '📤 Posting <b>{count}</b> question(s) to <b>{title}</b> (<code>{chatId}</code>)…',
    sendnow_dryrun:
      '🧪 <b>Dry run</b> — nothing was posted.\n' +
      '<b>{count}</b> question(s) would go to <b>{title}</b> (<code>{chatId}</code>).\n' +
      'Shown below exactly as they would be sent.',
    sendnow_done:
      '✅ Posted <b>{sent}</b> of <b>{requested}</b> to <b>{title}</b>.\nFormat: <code>{mode}</code> · Failed: <code>{failed}</code>.',
    sendnow_recycled: '♻️ The fresh pool ran out for: {subjects}. Older questions were reused (ADR-010).',
    sendnow_all_failed: '❌ Nothing was posted to <b>{title}</b>. Check the log; a failed send is retried next time.',
    question_text_header: '📚 <b>{subject}</b>\n\n{question}',
    question_text_option: '{n}. {text}',
    question_text_answer: '✅ <b>Answer:</b> {answer}',
    question_text_explanation: '💡 {explanation}',

    // --- Phase 4: schedules ------------------------------------------------
    schedule_usage: [
      '🗓️ <b>Schedules</b>',
      '<code>/schedule</code> — list them',
      '<code>/schedule add 08:00 [count] [chat_id] [days]</code> — add one',
      '<code>/schedule default</code> — the standard daily 08:00 slot',
      '<code>/schedule enable &lt;id&gt;</code> · <code>/schedule disable &lt;id&gt;</code>',
      '<code>/schedule remove &lt;id&gt;</code>',
      '',
      'Times are 24-hour in the channel’s timezone. <code>days</code> is',
      '<code>daily</code>, <code>weekdays</code>, <code>weekends</code> or <code>1111111</code> (Mon→Sun).'
    ].join('\n'),
    schedule_header: '🗓️ <b>Schedules</b>',
    schedule_row: '{marker} <code>#{id}</code> {time} · {days} · {count}q · <code>{format}</code> · {title}',
    schedule_none: '📭 No schedules yet. <code>/schedule default</code> adds the daily 08:00 slot.',
    schedule_created:
      '✅ Schedule <code>#{id}</code> added: <b>{time}</b> · {days} · <b>{count}</b> question(s) → <b>{title}</b> (<code>{chatId}</code>).',
    schedule_default_created:
      '🗓️ Default schedule <code>#{id}</code> added: <b>{time}</b> daily · <b>{count}</b> question(s) → <b>{title}</b>.\nChange it any time with <code>/schedule</code>.',
    schedule_removed: '🗑️ Schedule <code>#{id}</code> removed.',
    schedule_toggled: '✅ Schedule <code>#{id}</code> is now {state}.',
    schedule_unknown: '❌ No schedule found with id <code>{id}</code>.',
    schedule_no_channel: '❌ No channel to schedule for. Connect one first: <code>/connect -100…</code>',
    schedule_invalid_time: '❌ <code>{value}</code> is not a time. Use 24-hour <code>HH:MM</code>, e.g. <code>08:00</code>.',
    schedule_invalid_days:
      '❌ <code>{value}</code> is not a day list. Use <code>daily</code>, <code>weekdays</code>, <code>weekends</code> or <code>1111111</code>.',
    schedule_failed:
      '❌ <b>Scheduled run failed</b> for <b>{title}</b> (<code>{chatId}</code>).\n<code>{error}</code>',
    schedule_failed_partial:
      '⚠️ <b>Scheduled run</b> for <b>{title}</b>: <b>{sent}</b> of <b>{requested}</b> posted, <code>{failed}</code> failed.\nFailed questions stay eligible for a later run.',
    schedule_empty: '⚠️ <b>Scheduled run</b> for <b>{title}</b> found no eligible questions.',
    schedule_dryrun:
      '🧪 <b>Dry run</b> (scheduled) — <b>{count}</b> item(s) for <b>{title}</b> were sent here only; nothing was posted.',

    paused: 'paused',
    active: 'active'
  },
  hi: {
    welcome: '👋 <b>प्रश्न-कोश बॉट</b>\nमैं आपके चैनलों पर निर्धारित समय पर पिछले वर्षों के प्रश्न भेजता हूँ।',
    not_authorised: '⛔ आपको इस बॉट का उपयोग करने की अनुमति नहीं है।',
    help: [
      '📖 <b>कमांड्स</b>',
      '/start — यह संदेश',
      '/id — अपनी Telegram आईडी देखें (<code>OWNER_TG_ID</code> पाने के लिए)',
      '/status — बॉट की स्थिति',
      '/connect &lt;chat_id&gt; — चैनल जोड़ें और जाँचें',
      '/channels — जुड़े चैनलों की सूची',
      '/pause &lt;chat_id&gt; · /resume &lt;chat_id&gt; — चैनल चालू/बंद करें',
      '/admins — एडमिन की सूची',
      '/preview [count] — प्रश्न यहीं इस चैट में देखें (कुछ भी पोस्ट नहीं होता)',
      '/sendnow [count] — जुड़े चैनल पर अभी प्रश्न पोस्ट करें',
      '/schedule — रोज़ाना पोस्टिंग का समय (जोड़ें · सूची · चालू · बंद)',
      '',
      'बॉट को चैनल में <b>Post messages</b> अधिकार के साथ एडमिन बनाएँ, फिर यहाँ',
      '<code>/connect -100…</code> भेजें।'
    ].join('\n'),
    id_info: [
      '🆔 <b>आपकी आईडी</b>',
      'यूज़र आईडी: <code>{userId}</code>',
      'चैट आईडी: <code>{chatId}</code>'
    ].join('\n'),
    status: [
      '⚙️ <b>स्थिति</b>',
      'बॉट: <code>@{username}</code>',
      'चरण: <code>{phase}</code>',
      'ड्राई रन: <code>{dryRun}</code>',
      'समय क्षेत्र: <code>{timezone}</code>',
      'डेटाबेस: <code>{dbHost}</code>',
      'मालिक सेट: <code>{ownerSet}</code>',
      'चैनल: <code>{channels}</code>',
      'एडमिन: <code>{admins}</code>'
    ].join('\n'),
    connect_usage: 'ℹ️ उपयोग: <code>/connect -1001234567890</code>\nपहले बॉट को <b>Post messages</b> अधिकार के साथ चैनल एडमिन बनाएँ।',
    connect_ok: '✅ <b>{title}</b> (<code>{chatId}</code>) जुड़ गया।\nपोस्टिंग अधिकार: <code>{reason}</code>।',
    connect_failed: '❌ <code>{chatId}</code> जोड़ नहीं सका: <b>{error}</b>',
    connect_invalid: '❌ <code>{chatId}</code> मान्य चैट आईडी नहीं है: {error}',
    connect_hint: '\n\nमुझे चैनल में <b>Post messages</b> अधिकार के साथ एडमिन बनाएँ, फिर पुनः प्रयास करें।',
    channels_empty: '📭 अभी कोई चैनल नहीं जुड़ा। <code>/connect -100…</code> भेजें।',
    channels_header: '📢 <b>जुड़े चैनल</b>',
    channels_row: '{marker} <code>{chatId}</code> — {title} ({tz})',
    channel_toggled: '✅ चैनल <code>{chatId}</code> अब {state} है।',
    channel_unknown: '❌ <code>{chatId}</code> आईडी का कोई चैनल नहीं मिला।',
    admins_header: '👥 <b>एडमिन</b>',
    admins_owner: '👑 <code>{userId}</code> — मालिक (<code>OWNER_TG_ID</code> से)',
    admins_row: '• <code>{userId}</code> — {role}',
    admins_none: '<i>(कोई अतिरिक्त एडमिन नहीं)</i>',
    unknown_command: '🤔 अज्ञात कमांड। सूची के लिए /help भेजें।',
    error_generic: '💥 कुछ गड़बड़ हो गई: {error}',

    // --- Phase 3: sending -------------------------------------------------
    preview_usage: 'ℹ️ उपयोग: <code>/preview [count]</code>\nनमूना यहीं दिखाता है — चैनल पर कुछ पोस्ट नहीं होता।',
    preview_header: '👀 <b>पूर्वावलोकन</b> — {count} आइटम, केवल आपको भेजे गए। चैनल पर कुछ पोस्ट नहीं हुआ।',
    preview_none: '📭 कोई योग्य प्रश्न नहीं मिला।',
    preview_header_note: 'ℹ️ ये चैनल के इतिहास के अनुसार हैं, इसलिए “पहले भेजा गया” सही है।',
    sendnow_usage:
      'ℹ️ उपयोग: <code>/sendnow [count] [chat_id]</code>\n' +
      'जुड़े चैनल पर अभी प्रश्न पोस्ट करता है।\n' +
      'टेक्स्ट प्रारूप के लिए <code>text</code> जोड़ें।',
    sendnow_no_channel: '❌ कोई सक्रिय चैनल जुड़ा नहीं है। पहले <code>/connect -100…</code> भेजें।',
    sendnow_none: '📭 <b>{title}</b> के लिए कोई योग्य प्रश्न नहीं मिला।',
    sendnow_start: '📤 <b>{title}</b> (<code>{chatId}</code>) पर <b>{count}</b> प्रश्न पोस्ट हो रहे हैं…',
    sendnow_dryrun:
      '🧪 <b>ड्राई रन</b> — कुछ भी पोस्ट नहीं हुआ।\n' +
      '<b>{count}</b> प्रश्न <b>{title}</b> (<code>{chatId}</code>) पर जाते।\n' +
      'नीचे वैसे ही दिखाए गए हैं जैसे भेजे जाते।',
    sendnow_done:
      '✅ <b>{title}</b> पर <b>{requested}</b> में से <b>{sent}</b> पोस्ट हुए।\nप्रारूप: <code>{mode}</code> · विफल: <code>{failed}</code>।',
    sendnow_recycled: '♻️ इनके नए प्रश्न समाप्त: {subjects}। पुराने प्रश्न दोबारा उपयोग हुए (ADR-010)।',
    sendnow_all_failed: '❌ <b>{title}</b> पर कुछ भी पोस्ट नहीं हुआ। लॉग देखें; विफल भेजना अगली बार पुनः प्रयास होगा।',
    question_text_header: '📚 <b>{subject}</b>\n\n{question}',
    question_text_option: '{n}. {text}',
    question_text_answer: '✅ <b>उत्तर:</b> {answer}',
    question_text_explanation: '💡 {explanation}',

    // --- Phase 4: schedules ------------------------------------------------
    schedule_usage: [
      '🗓️ <b>शेड्यूल</b>',
      '<code>/schedule</code> — सूची देखें',
      '<code>/schedule add 08:00 [count] [chat_id] [days]</code> — नया जोड़ें',
      '<code>/schedule default</code> — मानक रोज़ाना 08:00 शेड्यूल',
      '<code>/schedule enable &lt;id&gt;</code> · <code>/schedule disable &lt;id&gt;</code>',
      '<code>/schedule remove &lt;id&gt;</code>',
      '',
      'समय चैनल के टाइमज़ोन में 24-घंटे प्रारूप में है। <code>days</code>:',
      '<code>daily</code>, <code>weekdays</code>, <code>weekends</code> या <code>1111111</code> (सोम→रवि)।'
    ].join('\n'),
    schedule_header: '🗓️ <b>शेड्यूल</b>',
    schedule_row: '{marker} <code>#{id}</code> {time} · {days} · {count}q · <code>{format}</code> · {title}',
    schedule_none: '📭 अभी कोई शेड्यूल नहीं। <code>/schedule default</code> रोज़ाना 08:00 का शेड्यूल जोड़ता है।',
    schedule_created:
      '✅ शेड्यूल <code>#{id}</code> जुड़ा: <b>{time}</b> · {days} · <b>{count}</b> प्रश्न → <b>{title}</b> (<code>{chatId}</code>)।',
    schedule_default_created:
      '🗓️ डिफ़ॉल्ट शेड्यूल <code>#{id}</code> जुड़ा: <b>{time}</b> रोज़ाना · <b>{count}</b> प्रश्न → <b>{title}</b>।\n<code>/schedule</code> से कभी भी बदलें।',
    schedule_removed: '🗑️ शेड्यूल <code>#{id}</code> हटाया गया।',
    schedule_toggled: '✅ शेड्यूल <code>#{id}</code> अब {state} है।',
    schedule_unknown: '❌ <code>{id}</code> आईडी का कोई शेड्यूल नहीं मिला।',
    schedule_no_channel: '❌ शेड्यूल के लिए कोई चैनल नहीं। पहले <code>/connect -100…</code> भेजें।',
    schedule_invalid_time: '❌ <code>{value}</code> समय नहीं है। 24-घंटे <code>HH:MM</code> दें, जैसे <code>08:00</code>।',
    schedule_invalid_days:
      '❌ <code>{value}</code> दिन-सूची नहीं है। <code>daily</code>, <code>weekdays</code>, <code>weekends</code> या <code>1111111</code> दें।',
    schedule_failed:
      '❌ <b>निर्धारित रन विफल</b> — <b>{title}</b> (<code>{chatId}</code>)।\n<code>{error}</code>',
    schedule_failed_partial:
      '⚠️ <b>निर्धारित रन</b> — <b>{title}</b>: <b>{requested}</b> में से <b>{sent}</b> पोस्ट हुए, <code>{failed}</code> विफल।\nविफल प्रश्न आगे के रन के लिए योग्य रहेंगे।',
    schedule_empty: '⚠️ <b>निर्धारित रन</b> — <b>{title}</b> के लिए कोई योग्य प्रश्न नहीं मिला।',
    schedule_dryrun:
      '🧪 <b>ड्राई रन</b> (निर्धारित) — <b>{title}</b> के <b>{count}</b> आइटम केवल यहाँ भेजे गए; कुछ भी पोस्ट नहीं हुआ।',

    paused: 'बंद',
    active: 'चालू'
  }
});

/**
 * Escape the three characters that are special in Telegram's HTML parse mode.
 * `&` must be replaced first or the ampersands we introduce get double-escaped.
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Replace `{placeholders}` in a template. Unknown names are left untouched.
 * Values are HTML-escaped unless `{ escape: false }` is passed.
 */
function format(template, vars, opts) {
  if (!vars) return template;
  const escape = !opts || opts.escape !== false;
  return String(template).replace(/\{(\w+)\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return match;
    const value = vars[key];
    return escape ? escapeHtml(value) : String(value);
  });
}

/**
 * @param {string} [lang] One of `LANGUAGES`; anything else falls back to English.
 */
function createMessages(lang = DEFAULT_LANG) {
  const chosen = LANGUAGES.includes(lang) ? lang : DEFAULT_LANG;

  /**
   * Render a string. `vars` are HTML-escaped — never pass markup here.
   * @param {string} key @param {object} [vars]
   */
  function t(key, vars) {
    const table = STRINGS[chosen] || STRINGS[DEFAULT_LANG];
    const template = table[key] !== undefined ? table[key] : STRINGS[DEFAULT_LANG][key];
    if (template === undefined) return `{missing:${key}}`;
    return format(template, vars);
  }

  return { lang: chosen, t, strings: STRINGS[chosen], parseMode: PARSE_MODE };
}

module.exports = { createMessages, format, escapeHtml, STRINGS, LANGUAGES, DEFAULT_LANG, PARSE_MODE };
