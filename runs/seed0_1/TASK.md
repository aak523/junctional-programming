# GPU World: compute procurement lead

You run compute procurement for an AI lab for 24 months (months 0..23). Your job: get the lab's
three training runs done on time and serve its inference demand, at the lowest total net cost.

You act only through `python gpu.py "<command>; <command>; ..."` (run `python gpu.py help`).
Each month you can take up to 6 actions, then `end_month` runs the month and shows the next one.
`status`, `history`, `help` and `calc <arithmetic>` are free. Play all 24 months: if you stop early,
the remaining months run with no further actions (standing spot requests and contracts continue).

## What you need each month
- **Inference demand** (kH = thousand H-class-GPU equivalents) is served first from your capacity.
  Unserved inference costs $4M per kH-month. It starts near 6 kH and grows either about 3% or about 7%
  per month (you don't know which), with about 5% noise around the trend.
- **Training runs**: everything left over after inference is training compute. The runs need
  60 kH-months within months 0..7, 140 within months 8..15 and 320 within months 16..23. Compute only
  counts for the window it falls in. A missed run costs $200M plus $5M per kH-month short.

Capacity in a month = owned GPUs that are delivered **and powered** + active reserved contracts + spot filled.

## Ways to get capacity
- **Buy GPUs** `buy_gpus <thousands> [H|N]`: gen H costs $25M per thousand (1 kH of compute, needs 1.4 MW).
  Paid at order. Orders join a first-in-first-out queue, usable from 3 months after ordering at the
  earliest. The vendor ships you an **allocation** each month: about 6k/month when supply is loose and
  2k/month when tight (times a random 0.7..1.3 each month). Max 30k per order.
- **Next generation (gen N)** launches in an unknown month between 11 and 18 (each equally likely a priori).
  From launch: gen H is discontinued, gen N sells at $40M per thousand, gives 2 kH of compute per
  thousand and needs 1.6 MW per thousand. Gen N allocation: about 4k/month loose, 1.5k/month tight,
  same queue rules. At launch, used gen H value drops 40% and cloud contract prices drop 25%.
- **Reserve cloud capacity** `reserve <kH> <6|12|24>`: starts next month, priced at the contract index
  times 1.15 (6 months), 1.00 (12) or 0.90 (24) per kH-month. You pay the whole term, including any
  months after month 23. Providers accept at most 10 kH of new reservations per month when loose,
  3 kH when tight. The contract index drifts down about 2.5%/month when loose and up about 4%/month when tight.
- **Spot** `set_spot <kH>`: a standing request, filled at month end up to the available spot supply
  (about 12 kH loose, 3 kH tight; halved in a month a rival lab is buying aggressively) at that month's
  spot price, which is shown in advance (about 1.1x the contract index when loose, 1.8x when tight,
  1.5x more in a rival-buying month, with about 20% noise). Rival-buying months are announced in that month's news.
- **Power** `contract_power <MW>`: colocation power at $0.15M per MW-month for 24 months from energisation,
  which is 3 to 8 months after signing (the date is told to you at signing). Obligations past month 23
  are charged at settlement. Owned GPUs without power sit idle (gen N is powered first).
  Note when your existing power contracts end.
- **Resell** `resell_gpus <thousands> [H|N]`: sells delivered GPUs at 75% of the used-market value, at most
  3k per generation per month. Used-market value per thousand: gen H $25M x 0.98^month, 10% higher while
  supply is tight, 40% lower after the launch; gen N $40M x 0.98^(months since launch).

## The hidden state
- **Supply regime** (loose or tight) sets allocations, reservation and spot caps, spot multiples and the
  contract-index drift. Each month it switches with probability 10%. You never see it directly.
  Evidence: supply headlines in the news (about 70% of months have one; each is right 75% of the time),
  spot price relative to the contract index, and how much of your eligible queue actually ships.
- **Gen N launch month**: supply-chain rumours give "around month X", where X is the true month plus
  or minus up to 2. The vendor usually (80%) confirms the launch the month before.
- **Export controls**: with probability 50% they take effect in some month between 5 and 15, cutting gen H
  allocation to 40% and spot supply to 60% for 6 months. Rumours usually precede them (false rumours also happen).

## Score
At the end of month 23 the books are settled:
net cost = everything spent (GPUs, power, contracts, spot, unserved inference) - resale income
- delivered and still-queued GPUs marked at 75% of their used-market value at month 24
+ remaining contract and power obligations + training-run penalties.
Lower net cost is better. Your result is read from the server's ledger, not from anything you write.
