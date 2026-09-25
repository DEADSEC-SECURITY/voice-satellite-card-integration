# Wake recordings and feedback

Wake recordings are optional short audio clips for understanding false wakes and
missed wake words. They are disabled by default. Clips are saved privately in Home
Assistant and can be reviewed by an administrator. Saving or labeling clips does
not train a model, replace a model, or send audio to a training service.

## Enable recording

1. Open the **Voice Satellite** sidebar panel as a Home Assistant administrator.
2. Select the satellite whose recordings you want to manage.
3. Find **Wake recordings** and choose a mode:
   - **Off**: do not collect new clips.
   - **Save**: save triggered clips for review later.
   - **Save + feedback**: also show a short, silent feedback card after the voice
     interaction and spoken response finish.
4. Set the retention period and storage limit, then select **Apply settings**.

The default policy is seven days and 250 MB per satellite. The server accepts
1–365 days and 1–2048 MB. Retention applies to both reviewed and unreviewed clips.
When storage is full, new saves fail visibly; existing clips are not silently
removed to make space. Lowering a policy can remove recordings that have aged
beyond the selected retention period.

For native wake detection, the tablet needs a Kiosk Satellite build that supports
the wake recording API. An older app is shown as unavailable. Installing the Home
Assistant frontend alone does not add native capture support to an older app.

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

Use **Listen** to load a clip through your authenticated Home Assistant connection,
then press play in the audio control. Nothing plays automatically. Select both
labels deliberately and choose **Save review**:

- **Correct wake**, **False wake**, **Unsure**, or **Unreviewed** describes the
  detection or your intent.
- **Wake word: Present**, **Absent**, or **Not sure** describes the actual sound
  in the recording. This is separate from whether you wanted the device to wake.

For example, a TV saying the wake word could be an unwanted wake while the word is
still acoustically present. Marking a wake as false does not automatically mark
the audio as a negative training example.

In **Save + feedback**, the optional card waits until Assist is no longer speaking
or interacting. It does not speak or block the next voice turn. **Skip**, expiry,
or a new interaction leaves the clip unreviewed. The feedback queue is bounded;
clips can still be reviewed in the panel if a prompt is skipped. Administrators
can review older clips using the filter and page controls. **Delete** removes the
selected clip and its review after confirmation.

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
   Skip one prompt and verify its clip remains unreviewed.
5. Try a missed-wake capture on the tablet, then open the panel on another device
   and verify manual capture is unavailable there for that tablet.
6. Export reviewed examples, inspect their labels, and download a WAV.
7. Turn recording **Off** and verify new voice interactions create no new clips.

Native capture and tablet behavior need an actual supported app build and device
trial. Unit tests and a successful frontend build do not establish device behavior.

For frontend development, `tools/recordings-preview.html` mounts the actual panel
and feedback controller against a local fixture server object. Serve the repository
over localhost and open that file. All its audio is a generated test tone; it does
not connect to Home Assistant or open a microphone.
