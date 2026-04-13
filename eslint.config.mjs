import jsdoc from "eslint-plugin-jsdoc"
import tsParser from "@typescript-eslint/parser"

/** @type {import("eslint").Linter.Config[]} */
const config = [
	{
	  files: ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.mjs"],
	  languageOptions: {
	    parser: tsParser,
	    sourceType: "module",
	    ecmaVersion: "latest",
	  },
	  plugins: {
	    jsdoc,
	  },
	  rules: {
	    "jsdoc/check-alignment": "error",
	    "jsdoc/check-indentation": "error",
	    "jsdoc/no-bad-blocks": "error",
	    "jsdoc/require-asterisk-prefix": "error",
	  },
	  settings: {
	    jsdoc: {
	      mode: "typescript",
	    },
	  },
	},
]

export default config
