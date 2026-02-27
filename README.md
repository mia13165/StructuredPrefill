https://rentry.org/structuredprefill

## TLDR?
1) install the extension  
2) add an **assistant-role** message at the very bottom (your prefill)  
3) send a message like normal  
4) StructuredPrefill auto-activates (when supported) and the reply is forced to begin with your prefill

## Prefill Generator (`[[pg]]`)
Models like Gemini 3.1, Opus 4.6, and GPT 5.1 are removing/limiting normal assistant prefills.

`[[pg]]` is a workaround: it lets you generate a tiny “starter” prefill using a separate (more uncensored) model, then forces your main model to start with it.

How it works:
- You pick a **Connection Profile** in SillyTavern for the “prefill generator” model.
- That model generates a short snippet (limited by your max tokens, e.g. ~15 tokens).
- StructuredPrefill replaces `[[pg]]` with that snippet and then runs normally (schema forces the reply to start with it).

### Recommended usage with `[[keep]]`
If you enable "Hide prefill text in the final message", you can hide everything before `[[keep]]` while still forcing the model to start with it.
For the cleanest experience, end your prefill with:

```text
... [[keep]]
[[pg]]
```

This makes only the generated prefill tail visible/saved (everything before `[[keep]]` is hidden/stripped).

## USECASE?
Models like Opus 4.6 and many more to come are REMOVING prefill. We can NOT have this, and so we have to find an alternate way to get the prefill functionality back in a way that may even be better than regular prefilling.

Also, for models like GPT 5.2 and GPT 5.1 this makes it monumentally easier to jailbreak as the model genuinely thinks its writing whatever is in your prefill.
