'use strict'
// The plain reader's page: the host posts `{ key, summary, text, url }`; a button answers with
// `{ result: { action } }`, which closes the overlay and lets the host act. Esc closes it with
// no action. The text goes in through textContent (it is Jira's, so untrusted).
ccPanel.onMessage((m) => {
  if (!m || typeof m.text !== 'string') return
  document.getElementById('text').textContent = m.text
  document.title = `${m.key}: ${m.summary}`
})
for (const [id, action] of [['discuss', 'discuss'], ['new', 'newSession'], ['browser', 'browser']]) {
  document.getElementById(id).addEventListener('click', () => ccPanel.post({ result: { action } }))
}
