# Wake recordings and feedback

Wake recordings are optional short audio clips for understanding false wakes and
missed wake words. They are disabled by default. Clips are saved privately in Home
Assistant and can be reviewed by an administrator. Saving or labeling clips does
not train a model, replace a model, or send audio to a training service.

## Enable recording

1. Open the **Wake recordings** sidebar item as a Home Assistant administrator
   (`/voice-satellite-recordings`).
2. Choose a specific station in the inbox. **All stations** is for combined review;
   select one station to change its recording policy.
3. Choose a recording mode:
   - **Off**: do not collect new clips.
   - **Save**: save triggered clips for review later.
   - **Save + feedback**: also show a short, silent feedback card after the voice
     interaction and spoken response finish.
4. Set the retention period and storage limit, then select **Apply settings**.

Choosing a station here only filters the inbox. It does not assign this browser
to that station or start a microphone. **Voice Satellite / This device** controls
the local voice runtime separately. Auto start is also local to each browser, so
changing it on a review laptop does not change a tablet's startup preference.

The default policy is seven days and 250 MB per satellite. The server accepts
1–365 days and 1–2048 MB. Retention applies to both reviewed and unreviewed clips.
When storage is full, new saves fail visibly; existing clips are not silently
removed to make space. Lowering a policy can remove recordings that have aged
beyond the selected retention period.

For native wake detection, install a matching Kiosk Satellite build that supports
both the recording API and forwarding the page's station runtime identity before
updating the HA integration. An older app may lack capture support or fail native
voice requests. Installing the HA frontend alone cannot update the native app.

Only one device can run a station at a time. A second device trying to start that
station is directed to **Wake recordings** instead of taking it over. To move a
station deliberately, stop it on the current device, then press Start on the new
one. Reviewing its audio does not require moving the station.

When settings are changed from another device, an active recorder can take up to
30 seconds to refresh its policy. A suspended tablet WebView applies the change
when it resumes. Home Assistant rejects new saves immediately once the server
policy is **Off**, even before the client has refreshed.

## What a clip contains

- Up to five seconds of the audio actually supplied to wake detection, ending at
  the trigger. A newly started recorder may have less than five seconds available.
- Mono, 16 kHz PCM16 WAV audio. This first version has no post-trigger audio tail;
  it intentionally excludes the later Assist response and chime.
- Available context such as capture time, engine, model, sensitivity, microphone
  settings, source session, and detection score. Unsupported scores or model hashes
  are left unknown; they are not invented.

Stop-word detections are not collected as wake examples. The recorder uses the
existing inference audio stream and does not open a second microphone.

The browser has a bounded queue of 20 clips awaiting save; the native app has a
bounded queue of 32. Pending clips are held in memory, so reloading the browser or
ending the app process can lose unsaved audio. The native queue can survive a
suspended WebView or a same-satellite WebView reload when pending clips are
retained; it cannot survive app process death. Switching owners clears pending
native clips so they cannot be attributed to another satellite. Dropped clips and pending saves are
shown for the current device. A server acknowledgement means the clip was saved;
it does not mean the clip has been reviewed.

## Review a recording

Open **Wake recordings** and choose **All stations** or one station. The combined
inbox shows each clip's station and pages through the merged results, newest first.
The selected station is independent of the browser's **This device** assignment.

Use **Listen** to load a clip through your authenticated Home Assistant connection,
then press play in the audio control. Nothing plays automatically.

While a clip plays, wake detection on the playback device is suspended so the
recorded wake word cannot wake that device again. Pausing, finishing, or leaving
the review stops this playback hold; any separate spoken-response hold remains.

Select both labels deliberately. Each change saves automatically; check for
**Saved** below the recording. **Saving…** means the server has not acknowledged
the change yet. A failed save keeps your answers and shows **Retry save**. Rapid
changes are queued per recording, and refreshing the inbox retains unsaved edits.
Reviewed export waits for pending saves and refuses to export failed edits.

- **Correct wake**, **False wake**, **Unsure**, or **Unreviewed** describes the
  detection or your intent.
- **Wake word: Present**, **Absent**, or **Not sure** describes the actual sound
  in the recording. This is separate from whether you wanted the device to wake.

Each clip displays its actual duration. A subsecond clip is marked as having
limited audio context; it is not padded to make it look like a full recording.

For example, a TV saying the wake word could be an unwanted wake while the word is
still acoustically present. Marking a wake as false does not automatically mark
the audio as a negative training example.

In **Save + feedback**, the optional card waits until Assist is no longer speaking
or interacting. Its large touch buttons first ask **Did you mean to wake me?**,
then independently ask **Was the wake word said?** Choose both answers and tap
**Save feedback**; **Back** lets you change an answer. A failed save retains your
answers so you can retry.

The card does not speak or block the next voice turn. **Review later**, expiry,
or a new interaction leaves unsent feedback unreviewed. The feedback queue is
bounded; clips remain available in the inbox when a prompt is skipped.
Administrators can review older clips using the filter and page controls.
**Delete** removes the selected clip and its review after confirmation.

## Capture a missed wake

On the device running the selected satellite, say the wake word and immediately
select **Capture missed wake**. This saves the recent wake-listening audio from
that device. It is a manual snapshot, not a remote microphone command. Recording
must be enabled and the recorder must have recent audio available. The button is
unavailable when the panel is controlling a different device or the native app
lacks recording support. Review the saved clip before assigning acoustic labels.

## Export reviewed examples

**Export reviewed page** downloads one JSON file containing reviewed recordings
from the current page, including metadata, both labels, a suggested WAV filename,
and the WAV bytes encoded as `audio_base64`. At most 25 items are exported at once.
Unreviewed items are excluded, and the server label is checked again before
export. **Unsure** items remain explicitly uncertain in the export.

Use **Download WAV** on an individual item for an ordinary audio file. Choose a
different page to export additional reviewed examples. Exported audio is a local
download chosen by you; there is no automatic training upload or retraining job.
Keep recordings from the same source session together when later preparing
training and evaluation datasets. A fresh recording is needed to test a model
after it has learned from these examples.

## Trial checklist

1. Enable **Save** and verify a deliberate wake produces one playable saved clip.
2. Confirm the normal voice request and response still work without waiting for
   the recording upload.
3. Trigger a known false wake and label it without assuming the word is absent.
4. Enable **Save + feedback** and confirm the card appears only after the response.
   Complete both questions once, then choose Review later on another prompt and
   verify that clip remains unreviewed.
5. On a laptop, review the tablet and All stations in **Wake recordings**. Verify
   the tablet still responds, saves clips, and asks for feedback. A deliberate
   attempt to start the laptop as that active station must be rejected without
   interrupting the tablet. Clear the laptop's test assignment afterward.
6. Briefly disconnect/reconnect the tablet and reload its WebView. Verify a new
   wake works and each queued clip appears once under the correct station.
7. Try a missed-wake capture on the tablet, then verify capture is unavailable
   for that tablet from the laptop review page.
8. Export reviewed examples, inspect their labels, and download a WAV.
9. Turn recording **Off** and verify new voice interactions create no new clips.

Native capture and tablet behavior need an actual supported app build and device
trial. Unit tests and a successful frontend build do not establish device behavior.

For frontend development, `tools/recordings-preview.html` mounts the actual panel
and feedback controller against a local fixture server object; **Preview feedback
popup** opens the touch flow. `tools/recordings-inbox-preview.html` exercises the
standalone inbox. Serve the repository over localhost and open either file. All
fixture audio is generated; neither connects to HA or opens a microphone.
