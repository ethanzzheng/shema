#!/bin/zsh
# Run chunking variants over a set of recorded runs through the replay
# simulator, then time and judge each result.
#   evals/tune-round.sh "<run> <run> ..." "<variant>=<tuning json>[|--mode fast]" ...
cd "$(dirname "$0")/.."
T=node_modules/.bin/tsx
runs=(${=1}); shift
for spec in "$@"; do
  name=${spec%%=*}; rest=${spec#*=}; tuning=${rest%%|*}; extra=""; [[ $rest == *"|"* ]] && extra=${rest#*|}
  for run in $runs; do
    (
      $T evals/chunk-replay.ts --label $run --variant $name --tuning "$tuning" ${=extra} > /dev/null 2>&1 &&
      $T evals/timing-report.ts --label "$run~$name" > /dev/null 2>&1 &&
      $T evals/run-to-replay.ts --label "$run~$name" > /dev/null &&
      $T evals/judge-translations.ts --run "$run~$name" --replay live --cols live > /dev/null 2>&1 &&
      $T evals/judge-coherence.ts --run "$run~$name" --replay live --col live > /dev/null 2>&1 &&
      echo "done $run~$name" || echo "FAILED $run~$name"
    ) &
  done
  wait
done
