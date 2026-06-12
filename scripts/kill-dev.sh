#!/usr/bin/env bash
for p in 3001 5173 5174 5175 5176; do
  lsof -ti :"$p" 2>/dev/null | xargs kill -9 2>/dev/null
done
echo "Stopped processes on ports 3001, 5173–5176"
