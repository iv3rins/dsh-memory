#!/usr/bin/env node
/**
 * Separate answer variance from judge variance using frozen phase3 rows.
 *
 * Reads existing results only. External calls require --execute and use the configured
 * OpenAI-compatible endpoint; without it this script is a dry run and prints the pairs
 * that would be measured. The same context is answered repeatedly, then one frozen answer
 * is judged repeatedly. Never regenerate the summary or atoms here.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { BENCH, OUT, apiKey, answer, judge } from './lib.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? fallback : args[index + 1]
}
const file = option('file', readdirSync(OUT).filter((name) => /^phase3-.*\.jsonl$/.test(name)).sort().at(-1))
if (file === undefined) throw new Error('no phase3 result is available; run phase3 first or pass --file')
if (Number.isSafeInteger(Number(option('questions', '5'))) !== true || Number(option('questions', '5')) < 1) throw new Error('--questions must be a positive integer')
const rows = readFileSync(path.isAbsolute(file) ? file : path.join(OUT, file), 'utf8').trim().split('\n')
  .map((line) => JSON.parse(line))
  .filter((row) => row.arms !== undefined)
const selected = rows.filter((row) => args.includes('--all') || args.some((arg) => arg === `--question=${row.question_id}` || arg === row.question_id)).slice(0, Number(option('questions', '5')))
const arm = option('arm', 'C')
const requestedRepeats = Number(option('repeats', '3'))
if (Number.isSafeInteger(requestedRepeats) !== true || requestedRepeats < 2 || requestedRepeats > 10) throw new Error('--repeats must be an integer between 2 and 10')
const repeats = requestedRepeats
const plan = selected.flatMap((row) => {
  const cell = row.arms[arm]
  if (cell !== undefined && (typeof cell.context !== 'string' || typeof cell.answer !== 'string')) {
    throw new Error(`${row.question_id}/${arm} predates frozen context capture; rerun phase3 to make this experiment auditable`)
  }
  return cell === undefined ? [] : [{
    projectId: row.project_id,
    questionId: row.question_id,
    contextFingerprint: createHash('sha256').update(cell.context).digest('hex'),
    answer: cell.answer,
  }]
})

if (args.includes('--execute') !== true) {
  console.log(JSON.stringify({ dryRun: true, file, arm, repeats, pairs: plan.length, plan }, null, 2))
  console.log('No LLM called. Add --execute to run this frozen-input experiment (may incur provider cost).')
} else {
  const key = apiKey()
  const results = []
  for (const item of plan) {
    const row = selected.find((entry) => entry.project_id === item.projectId && entry.question_id === item.questionId)
    const cell = row.arms[arm]
    const question = JSON.parse(readFileSync(path.join(BENCH, `${item.projectId}-questions.json`), 'utf8')).find((entry) => entry.id === item.questionId)
    if (createHash('sha256').update(cell.context).digest('hex') !== item.contextFingerprint) throw new Error(`context changed for ${item.questionId}`)
    const answers = []
    for (let index = 0; index < repeats; index += 1) answers.push(await answer(key, cell.context, question.question))
    const grades = []
    for (let index = 0; index < repeats; index += 1) grades.push(await judge(key, question.question, question.answer_short ?? question.answer, cell.answer))
    results.push({
      ...item,
      answers: answers.map((entry) => ({ text: entry.answer, requestFingerprint: entry.requestFingerprint, responseModel: entry.responseModel, systemFingerprint: entry.systemFingerprint })),
      answerUnique: new Set(answers.map((entry) => entry.answer)).size,
      judgeRequestsIdentical: new Set(grades.map((entry) => entry.requestFingerprint)).size === 1,
      verdicts: grades.map((entry) => entry.verdict),
      judgeReasons: grades.map((entry) => entry.reason),
      judgeUnique: new Set(grades.map((entry) => entry.verdict)).size,
    })
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(OUT, `variance-${stamp}.json`)
  writeFileSync(target, JSON.stringify({ file, arm, repeats, results }, null, 2), 'utf8')
  console.log(JSON.stringify({ written: target, pairs: results.length, answerChanged: results.filter((row) => row.answerUnique > 1).length, judgeChanged: results.filter((row) => row.judgeUnique > 1).length }, null, 2))
}
