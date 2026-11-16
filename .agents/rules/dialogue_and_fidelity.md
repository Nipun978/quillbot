# Quillbot Narrative & Architecture Directives

## 1. Zero-Invention & Author Intent Invariant
- Fiction workflows must strictly execute author-stated facts without inventing unmentioned characters, backstories, plot events, motivations, twists, or unmentioned physical props.
- Model temperatures for planning and writing must remain near-deterministic (Plan: 0.1, Write: 0.3).

## 2. Dialogue Speaker Attribution Integrity
- Every planned and drafted dialogue exchange must maintain absolute clarity regarding WHO speaks to WHOM.
- Dialogue content must strictly align with the speaker's established trade, social posture, and motivation.
- Never invert speakers, swap inquiry and response roles, or assign lines that contradict a character's known perspective.
- Scene planning and writing use at least `medium` reasoning effort to track speaker intent and character state.

## 3. Storage Self-Healing
- LanceDB table operations must anticipate manifest corruption (`magic number does not match`) from abrupt process termination and automatically purge the corrupted index, rebuild the table, and trigger a clean disk re-sync.
