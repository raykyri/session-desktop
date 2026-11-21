// What people typed (the members mockup's `PROMPTS`): each ask and branch
// question as it was typed to an agent, keyed by thread id and the fixture's
// node id ("q" is the thread's own ask). The fixture conversion stores these
// as the questions (02 §9.7: the stored `q` as sent).

export const PROMPTS: Record<string, Record<string, string>> = {
  "01M7HWGZJGT7JTFFVSYPX055KV": {
    q: "scan sci-fi + adjacent writing for intention marketplaces / intention networks. go broad, give me a list of examples",
    f0: "which of these actually let you trade intentions vs just make them visible",
    f1: "any non english ones",
    f2: "group by decade instead",
    g1: "how does the darknet in daemon decide who gets which task",
    g2: "which lem stories come closest to an intention market",
    h1: "so closer to a labour market or a reputation ledger",
  },
  "01M7HQMDT0RH0G2WHVJHQ6Z8C2": {
    q: "dagen h logistics. signage, the overnight changeover, accident stats before/after",
    f0: "why was the referendum result ignored",
    f1: "what happened w buses and trams",
  },
  "01M7HM6J60FXTCP97AMP8ZRX5E": {
    q: "public datasets for how long container ships wait at port. how far back does each go",
    f0: "how hard is it to get dwell times out of the noaa ais files",
    f1: "can any of these show the 2021 la/long beach queue",
  },
  "01M7H9WZA0CYDP5Z7ACZYSZTQ2": {
    q: "explain banach-tarski and show exactly where the axiom of choice gets used in the proof",
    f0: "why 3d but not 2d",
    f1: "is there a version w/o choice",
  },
  "01M7HTF26GS2MA4P948GD5K0EG": {
    q: "find novels + short stories where personal ai agents negotiate/bargain/trade for the people they work for",
    f0: "only the ones that show the actual back and forth, not just the outcome",
    f1: "anything where the agent is legally liable for what it agrees to",
  },
  "01M7H6F3P02JFX3X2X804X3986": {
    q: "compare video calls in 1960s sf vs how people actually use them now",
    f0: "did anyone back then predict people turning the camera off",
    f1: "how did they handle time zones / delay on long distance calls",
  },
  "01M7E164R0BPYCCAQ4CDZ2QSG8": {
    q: "trace how the meaning of metaverse changed from 1992 to now",
    f0: "did stephenson ever comment on companies using the word in 2021",
    f1: "is metaverse in the main dictionaries yet",
    f2: "compare the snow crash metaverse w the oasis in ready player one",
  },
  "01M7HGRPJ0E7RGZ45D4KENBQ6P": {
    q: "how do prediction markets deal w questions where the resolution criteria end up ambiguous",
    f0: "has a regulator ever overruled an exchange on a resolution",
    f1: "doesnt voiding create its own bad incentives",
    a3: "how big are the top uma voters holdings vs the markets they resolve",
    a4: "what does optimistic mean in optimistic oracle",
    a5: "where in the kalshi rulebook are outcomes the contract didnt anticipate",
    b1: "how often did augur v1 markets resolve invalid",
    b2: "can you separate void prob from event prob in the price",
    b3: "which disputed markets were these complaints about",
    b4: "current status of the kalshi election contracts litigation",
    c1: "has anyone listed a market on whether another market gets voided",
    c2: "work through a numeric example, 20% void prob",
    c3: "how did clarification work in that market",
    d1: "expected return if void prob is really 5% and i buy at 0.58",
    d2: "would a market on a void need its own ambiguous resolution rule",
    e1: "does that change if the stake is locked 6 months before resolution",
  },
  "01M7HM6J60Z1FFM56RSRTHFM2Y": {
    q: "summarize the main published results on test-time compute scaling, 2025-2026",
    f0: "parallel sampling vs longer single traces, which is cheaper at the same accuracy",
    f1: "any results outside math + code",
  },
  "01M7H9WZA0NR1T4T2TGBEKK21Y": {
    q: "why does tardigrade dsup protect human cells from xray damage",
    f0: "does it work for uv too",
    f1: "why would it hurt neurons if it helps hek293",
  },
  "01M7GW5GT0XMQGVRNF95PDQ8HV": {
    q: "how were medieval guild apprenticeships contracted + who enforced the terms",
    f0: "were girls apprenticed under the same contracts",
    f1: "what happened if the master died mid-term",
  },
  "01M7E164R0M5VQ0DTHTK7229GY": {
    q: "compare heat pump adoption in norway vs poland since 2010 and explain the gap",
    f0: "did heat pumps increase coal burn in poland via the grid",
    f1: "how do they cope w norwegian winters",
  },
  "01M7HDATY00YDFQVMNJW7VNX53": {
    q: "what happened after houston dropped parking minimums downtown",
    f0: "did street parking get worse in eado / midtown",
    f1: "has houston extended it since 2019",
  },
  "01M7HVAH3GCWYN0S5H6NX9WKRT": {
    q: "rerun the main table of the 2025 grokking-on-modular-arithmetic paper w their released code. which numbers reproduce",
    f0: "which sources is this leaning on most",
    f1: "what would change the conclusion",
    x1: "is the 3x step count consistent across seeds",
    x2: "which seeds + what weight decay",
  },
  "01M7H6F3P012CRWKEQVTVA6PV4": {
    q: "check if the speculative decoding speedup holds on consumer gpus w the released code",
    f0: "which sources is this leaning on most",
    f1: "what would change the conclusion",
  },
  "01M7H31820BK289S2XPP2DTK2N": {
    q: "does the default enrolment effect on retirement saving survive the revised survey weights",
    f0: "which sources is this leaning on most",
    f1: "what would change the conclusion",
  },
  "01M7E164R0RBHSCJH2YBWZ6AWG": {
    q: "compare managed postgres providers: pitr limits, cross-region read replicas",
    f0: "which sources is this leaning on most",
    f1: "what would change the conclusion",
  },
  "01M7E164R0Y9DN252RVM5BA939": {
    q: "track record of grant schemes that fund replication studies. who funds them, what share of funded projects finish",
    f0: "which sources is this leaning on most",
    f1: "what would change the conclusion",
  },
  "01M7BESDR08WWS4J3FKS5B43EB": {
    q: "how much notice does a landlord need to give before a rent increase under the current city ordinance",
    f0: "which sources is this leaning on most",
  },
  "01M7H9WZA09M3CNSPTFF22FZ86": {
    q: "is the 3.1x figure in this paragraph right? says it's from the appendix table in halvorsen et al",
    f0: "which sources is this leaning on most",
  },
  "01M7GB06P0P8ZXPB0DEXY3G3RT": {
    q: "which of the contamination claims in this thread has anyone else actually checked",
    f0: "which sources is this leaning on most",
    f1: "what would change the conclusion",
  },
  "01M7GRQN60V68CFNX27EE5W66S": {
    q: "where do the thread and orbit lab's response disagree + what evidence does each side give",
    f0: "which sources is this leaning on most",
  },
  "01M7BESDR0YSSVFVJ47HD56Y9M": {
    q: "which paper is lin feld describing here",
    f0: "which sources is this leaning on most",
  },
  "01M7E164R0B8KHNGZTQ0METX7J": {
    q: "what would it take to report flops per problem like this post proposes, for a closed model",
    f0: "which sources is this leaning on most",
  },
  "01M7GZKCE0ZYF4MBKKGYS455JM": {
    q: "rerun the near-dup search from the published script on a random sample of 200 problems, compare w the reported matches",
    f0: "which sources is this leaning on most",
  },
};
