https://rentry.org/structuredprefill

## TLDR?
1) install the extension  
2) add an **assistant-role** message at the very bottom (your prefill)  
3) send a message like normal  
4) StructuredPrefill auto-activates (when supported) and the reply is forced to begin with your prefill

## USECASE?
Models like Opus 4.6 and many more to come are REMOVING prefill. We can NOT have this, and so we have to find an alternate way to get the prefill functionality back in a way that may even be better than regular prefilling.

Also, for models like GPT 5.2 and GPT 5.1 this makes it monumentally easier to jailbreak as the model genuinely thinks its writing whatever is in your prefill.