# pakwone: BrainLock

BrainLock is a research prototype for EEG concealed-information testing (the P300 method popularly called "brain fingerprinting").

| Folder | What it is |
| --- | --- |
| `app/` | **BrainLock Examiner.** A browser app for the full test flow: build and lock a protocol, record consent with a pre-test interview, record a session (simulated headset or imported epoched CSV), and view a report. It imports and exports protocol files (`brainlock.protocol/1` JSON), and exports all sessions as CSV or JSON. |
| `app/brainprint.js` | Analysis engine used by every app. It covers stimulus sequencing, simulation, filtering, artifact rejection, dual-bootstrap analysis, calibration and attention ranking. |
| `app/pilot-protocol.json` | Protocol and study design for the BrainLock Validation Pilot. The stimuli are an example set, and no participants have been tested yet. |
| `dating/` | **Spark.** A dating-app prototype that uses your own P300 attention signal as a hint. Matches still need two explicit likes. |
| `callcheck/` | **Call Check.** A phone-scam checker that uses warning signs, challenge questions and callback verification. It needs no headset. |
| `landing/` | Crowdfunding landing page. It's a pre-launch draft. |

Serve the repo with any static server (for example `python3 -m http.server`) and open `/app/`, `/dating/`, `/callcheck/` or `/landing/`. The protocol import button loads `pilot-protocol.json` over HTTP, so opening the file directly from disk won't load it.

Everything runs in the browser. Data stays in the viewer's local storage unless they export it.
