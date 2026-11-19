import { isCategoryId } from './category.js'
import { tokenize } from './search.js'

const MAX_CLUSTER_ATOMS = 24
const COMMON_TERMS = new Set(
  ('an and are as at be been but by can do for from had has have how if in is it its may of on or our '
    + 'should than that the their them then there these they this to use used was we were what when where '
    + 'which will with would you your file files project src js jsx ts tsx mjs cjs json md').split(' '),
)

/** Index words, identifiers and paths, including phrases inside Han text. */
function topicTerms(text) {
  const terms = new Set()
  for (const match of text.matchAll(/\p{Script=Han}+|[^\p{Script=Han}\s]+/gu)) {
    const segment = match[0]
    if (/^\p{Script=Han}/u.test(segment)) {
      const chars = [...segment]
      for (let index = 1; index < chars.length; index += 1) terms.add(chars[index - 1] + chars[index])
      continue
    }
    for (const token of tokenize(segment)) {
      if (!COMMON_TERMS.has(token)) terms.add(token)
    }
  }
  for (const match of text.matchAll(/[\p{L}\p{N}_]+(?:[./\\-][\p{L}\p{N}_]+)+/gu)) {
    terms.add(match[0].replace(/\\/g, '/').toLowerCase())
  }
  return terms
}

function atomTopics(atom) {
  const topics = new Map([...topicTerms(atom.text)].map((term) => [term, 1]))
  for (const tag of atom.tags) {
    if (isCategoryId(tag)) continue
    for (const term of topicTerms(tag)) {
      if (!topics.has(term)) topics.set(term, 1)
    }
    topics.set(tag.toLowerCase(), 2)
  }
  for (const file of atom.files) {
    for (const term of topicTerms(file)) {
      if (!topics.has(term)) topics.set(term, 1)
    }
    topics.set(file.toLowerCase(), 3)
  }
  return topics
}

/**
 * Group live atoms around shared project vocabulary. Persisted memberships stay stable
 * while new observations join a matching topic or open a new cluster. Category IDs and
 * atom kinds are independent metadata and never determine where an atom is stored.
 */
export function buildMemoryClusters(atoms, memberships = new Map()) {
  const groups = new Map()
  const anchorsByTerm = new Map()
  const unassigned = []

  function add(id, atom, topics) {
    if (!groups.has(id)) {
      groups.set(id, { id, atoms: [], terms: new Set() })
      for (const [term, weight] of topics) {
        if (!anchorsByTerm.has(term)) anchorsByTerm.set(term, new Map())
        anchorsByTerm.get(term).set(id, weight)
      }
    }
    const group = groups.get(id)
    group.atoms.push(atom)
    for (const term of topics.keys()) group.terms.add(term)
  }

  for (const atom of atoms) {
    const id = memberships.get(atom.id)
    if (id === undefined) unassigned.push(atom)
    else add(id, atom, atomTopics(atom))
  }

  for (const atom of unassigned) {
    const topics = atomTopics(atom)
    const scores = new Map()
    for (const [term, weight] of topics) {
      for (const [id, clusterWeight] of anchorsByTerm.get(term) ?? []) {
        if (groups.get(id).atoms.length >= MAX_CLUSTER_ATOMS) continue
        const shared = Math.min(weight, clusterWeight)
        scores.set(id, (scores.get(id) ?? 0) + (shared >= 2 ? shared + 3 : shared))
      }
    }
    let groupId = `cluster-${atom.id}`
    // Compare potential members against the founding topic so a chain of weak
    // pairwise matches cannot turn a cluster into a collection of unrelated topics.
    let best = Math.max(2, Math.min(4, Math.ceil(topics.size / 8))) - 1
    for (const [id, score] of scores) {
      if (score <= best) continue
      best = score
      groupId = id
    }
    add(groupId, atom, topics)
  }

  return [...groups.values()].map(({ id, atoms, terms }) => ({ id, atoms, terms: [...terms] }))
}

/**
 * Locate topic clusters before selecting individual atoms. Refined searches can use
 * a narrower set of eligible atoms and can exclude already-rejected clusters.
 * Standing rules can enter the shortlist separately for the gate's own budget check.
 */
export function clusterCandidates({ clusters, query, atoms, limit, excludeClusterIds, includeStanding }) {
  const queryTerms = topicTerms(typeof query === 'string' ? query : query?.text ?? '')
  const eligible = atoms === undefined ? null : new Set(atoms.map((atom) => atom.id))
  const frequency = new Map()
  const matches = []
  const standing = []

  for (const cluster of clusters) {
    if (excludeClusterIds?.has(cluster.id)) continue
    const members = eligible === null ? cluster.atoms : cluster.atoms.filter((atom) => eligible.has(atom.id))
    if (members.length === 0) continue
    const terms = members.length === cluster.atoms.length
      ? cluster.terms
      : [...new Set(members.flatMap((atom) => [...atomTopics(atom).keys()]))]
    if (includeStanding === true) {
      const rules = members.filter((atom) => atom.standing === true)
      if (rules.length > 0) standing.push({ id: cluster.id, atoms: rules, terms })
    }
    const matched = terms.filter((term) => queryTerms.has(term))
    if (matched.length === 0) continue
    for (const term of matched) frequency.set(term, (frequency.get(term) ?? 0) + 1)
    matches.push({ id: cluster.id, atoms: members, terms, matched })
  }

  const ranked = matches.map(({ matched, ...cluster }) => ({
    ...cluster,
    score: matched.reduce((sum, term) => sum + 1 / frequency.get(term), 0),
  })).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  const selected = []
  const clusterIds = new Map()
  const selectedClusters = new Map()
  const max = limit ?? Infinity
  for (const cluster of ranked) {
    const room = max - selected.length
    if (room <= 0) break
    // A digest may fill before the shortlist limit, so put the strongest evidence
    // first inside each located topic.
    const rankedMembers = cluster.atoms.map((atom) => {
      let score = 0
      for (const [term, weight] of atomTopics(atom)) {
        if (queryTerms.has(term)) score += weight / frequency.get(term)
      }
      return { atom, score }
    })
    rankedMembers.sort((left, right) => right.score - left.score)
    const members = rankedMembers.slice(0, room).map(({ atom }) => atom)
    selectedClusters.set(cluster.id, { ...cluster, atoms: members })
    for (const atom of members) {
      selected.push(atom)
      clusterIds.set(atom.id, cluster.id)
    }
  }
  for (const cluster of standing) {
    const extra = cluster.atoms.filter((atom) => !clusterIds.has(atom.id))
    if (extra.length === 0) continue
    const matched = selectedClusters.get(cluster.id)
    if (matched === undefined) selectedClusters.set(cluster.id, { ...cluster, atoms: extra, score: 0 })
    else matched.atoms = [...matched.atoms, ...extra]
    for (const atom of extra) {
      selected.push(atom)
      clusterIds.set(atom.id, cluster.id)
    }
  }
  return { atoms: selected, clusterIds, clusters: [...selectedClusters.values()] }
}
