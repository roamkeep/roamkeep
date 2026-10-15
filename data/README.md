# data/

`common-passwords.txt`: the passwords the app refuses as a new password,
one per line, lower-cased (the check ignores case). They are the 5,000 most
common passwords of 8 to 72 characters in the UK National Cyber Security
Centre's list of the 100,000 most used passwords, as published in the
SecLists collection (MIT licence). `tools/gen-common-passwords.mjs`
regenerates the file and records the exact source.

`build.js` bundles it into `dist/pwcheck.js`, which the app loads only on
the screens that set a password. Nothing is fetched from anywhere else.
