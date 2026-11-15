| seed | Hydrogen reward | reference reward | do-nothing reward | Hydrogen % of reference | months played | runs met |
|---|---|---|---|---|---|---|
| 1001 | 0.813 | 0.836 | 0.202 | 97% | 24 | 3/3 |
| 1002 | 0.890 | 0.919 | 0.286 | 97% | 24 | 3/3 |
| 1003 | 0.693 | 0.841 | 0.189 | 82% | 24 | 3/3 |
| 1004 | 0.835 | 0.908 | 0.242 | 92% | 24 | 3/3 |
| 1005 | 1.000 | 0.906 | 0.327 | 110% | 24 | 3/3 |

Hydrogen at 95.8% of the reference on average over 5 games (sd 10.1%, standard error 4.5%); below the reference in 4 of 5.

Re-scored after the planners' option-ordering fix (466fcc7) and the re-tune (a9702d0). Hydrogen's actions are unchanged;
the reference and oracle are replayed on the same worlds:

| seed | Hydrogen reward | reference reward | Hydrogen % of reference |
|---|---|---|---|
| 1001 | 0.792 | 0.928 | 85% |
| 1002 | 0.821 | 0.966 | 85% |
| 1003 | 0.693 | 0.889 | 78% |
| 1004 | 0.814 | 0.918 | 89% |
| 1005 | 0.890 | 0.922 | 97% |

Hydrogen at 87% of the reference on average; below it in all 5.
