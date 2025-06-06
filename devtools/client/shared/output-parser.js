/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {
  angleUtils,
} = require("resource://devtools/client/shared/css-angle.js");
const { colorUtils } = require("resource://devtools/shared/css/color.js");
const {
  InspectorCSSParserWrapper,
} = require("resource://devtools/shared/css/lexer.js");
const {
  appendText,
} = require("resource://devtools/client/inspector/shared/utils.js");

const STYLE_INSPECTOR_PROPERTIES =
  "devtools/shared/locales/styleinspector.properties";
const { LocalizationHelper } = require("resource://devtools/shared/l10n.js");
const STYLE_INSPECTOR_L10N = new LocalizationHelper(STYLE_INSPECTOR_PROPERTIES);

// Functions that accept an angle argument.
const ANGLE_TAKING_FUNCTIONS = new Set([
  "linear-gradient",
  "-moz-linear-gradient",
  "repeating-linear-gradient",
  "-moz-repeating-linear-gradient",
  "conic-gradient",
  "repeating-conic-gradient",
  "rotate",
  "rotateX",
  "rotateY",
  "rotateZ",
  "rotate3d",
  "skew",
  "skewX",
  "skewY",
  "hue-rotate",
]);
// All cubic-bezier CSS timing-function names.
const BEZIER_KEYWORDS = new Set([
  "linear",
  "ease-in-out",
  "ease-in",
  "ease-out",
  "ease",
]);
// Functions that accept a color argument.
const COLOR_TAKING_FUNCTIONS = new Set([
  "linear-gradient",
  "-moz-linear-gradient",
  "repeating-linear-gradient",
  "-moz-repeating-linear-gradient",
  "radial-gradient",
  "-moz-radial-gradient",
  "repeating-radial-gradient",
  "-moz-repeating-radial-gradient",
  "conic-gradient",
  "repeating-conic-gradient",
  "drop-shadow",
  "color-mix",
  "light-dark",
]);
// Functions that accept a shape argument.
const BASIC_SHAPE_FUNCTIONS = new Set([
  "polygon",
  "circle",
  "ellipse",
  "inset",
]);

const BACKDROP_FILTER_ENABLED = Services.prefs.getBoolPref(
  "layout.css.backdrop-filter.enabled"
);
const HTML_NS = "http://www.w3.org/1999/xhtml";

// This regexp matches a URL token.  It puts the "url(", any
// leading whitespace, and any opening quote into |leader|; the
// URL text itself into |body|, and any trailing quote, trailing
// whitespace, and the ")" into |trailer|.
const URL_REGEX =
  /^(?<leader>url\([ \t\r\n\f]*(["']?))(?<body>.*?)(?<trailer>\2[ \t\r\n\f]*\))$/i;

// Very long text properties should be truncated using CSS to avoid creating
// extremely tall propertyvalue containers. 5000 characters is an arbitrary
// limit. Assuming an average ruleview can hold 50 characters per line, this
// should start truncating properties which would otherwise be 100 lines long.
const TRUNCATE_LENGTH_THRESHOLD = 5000;
const TRUNCATE_NODE_CLASSNAME = "propertyvalue-long-text";

/**
 * This module is used to process CSS text declarations and output DOM fragments (to be
 * appended to panels in DevTools) for CSS values decorated with additional UI and
 * functionality.
 *
 * For example:
 * - attaching swatches for values instrumented with specialized tools: colors, timing
 * functions (cubic-bezier), filters, shapes, display values (flex/grid), etc.
 * - adding previews where possible (images, fonts, CSS transforms).
 * - converting between color types on Shift+click on their swatches.
 *
 * Usage:
 *   const OutputParser = require("devtools/client/shared/output-parser");
 *   const parser = new OutputParser(document, cssProperties);
 *   parser.parseCssProperty("color", "red"); // Returns document fragment.
 *
 */
class OutputParser {
  /**
   * @param {Document} document
   *        Used to create DOM nodes.
   * @param {CssProperties} cssProperties
   *        Instance of CssProperties, an object which provides an interface for
   *        working with the database of supported CSS properties and values.
   */
  constructor(document, cssProperties) {
    this.#doc = document;
    this.#cssProperties = cssProperties;
  }

  #angleSwatches = new WeakMap();
  #colorSwatches = new WeakMap();
  #cssProperties;
  #doc;
  #parsed = [];
  #stack = [];

  /**
   * Parse a CSS property value given a property name.
   *
   * @param  {String} name
   *         CSS Property Name
   * @param  {String} value
   *         CSS Property value
   * @param  {Object} [options]
   *         Options object. For valid options and default values see
   *         #mergeOptions().
   * @return {DocumentFragment}
   *         A document fragment containing color swatches etc.
   */
  parseCssProperty(name, value, options = {}) {
    options = this.#mergeOptions(options);

    options.expectCubicBezier = this.#cssProperties.supportsType(
      name,
      "timing-function"
    );
    options.expectLinearEasing = this.#cssProperties.supportsType(
      name,
      "timing-function"
    );
    options.expectDisplay = name === "display";
    options.expectFilter =
      name === "filter" ||
      (BACKDROP_FILTER_ENABLED && name === "backdrop-filter");
    options.expectShape =
      name === "clip-path" ||
      name === "shape-outside" ||
      name === "offset-path";
    options.expectFont = name === "font-family";
    options.isVariable = name.startsWith("--");
    options.supportsColor =
      this.#cssProperties.supportsType(name, "color") ||
      this.#cssProperties.supportsType(name, "gradient") ||
      // Parse colors for CSS variables declaration if the declaration value or the computed
      // value are valid colors.
      (options.isVariable &&
        (InspectorUtils.isValidCSSColor(value) ||
          InspectorUtils.isValidCSSColor(
            options.getVariableData?.(name).computedValue
          )));

    // The filter property is special in that we want to show the
    // swatch even if the value is invalid, because this way the user
    // can easily use the editor to fix it.
    if (options.expectFilter || this.#cssPropertySupportsValue(name, value)) {
      return this.#parse(value, options);
    }
    this.#appendTextNode(value);

    return this.#toDOM();
  }

  /**
   * Read tokens from |tokenStream| and collect all the (non-comment)
   * text. Return the collected texts and variable data (if any).
   * Stop when an unmatched closing paren is seen.
   * If |stopAtComma| is true, then also stop when a top-level
   * (unparenthesized) comma is seen.
   *
   * @param  {String} text
   *         The original source text.
   * @param  {CSSLexer} tokenStream
   *         The token stream from which to read.
   * @param  {Object} options
   *         The options object in use; @see #mergeOptions.
   * @param  {Boolean} stopAtComma
   *         If true, stop at a comma.
   * @return {Object}
   *         An object of the form {tokens, functionData, sawComma, sawVariable, depth}.
   *         |tokens| is a list of the non-comment, non-whitespace tokens
   *         that were seen. The stopping token (paren or comma) will not
   *         be included.
   *         |functionData| is a list of parsed strings and nodes that contain the
   *         data between the matching parenthesis. The stopping token's text will
   *         not be included.
   *         |sawComma| is true if the stop was due to a comma, or false otherwise.
   *         |sawVariable| is true if a variable was seen while parsing the text.
   *         |depth| is the number of unclosed parenthesis remaining when we return.
   */
  #parseMatchingParens(text, tokenStream, options, stopAtComma) {
    let depth = 1;
    const functionData = [];
    const tokens = [];
    let sawVariable = false;

    while (depth > 0) {
      const token = tokenStream.nextToken();
      if (!token) {
        break;
      }
      if (token.tokenType === "Comment") {
        continue;
      }

      if (stopAtComma && depth === 1 && token.tokenType === "Comma") {
        return { tokens, functionData, sawComma: true, sawVariable, depth };
      } else if (token.tokenType === "ParenthesisBlock") {
        ++depth;
      } else if (token.tokenType === "CloseParenthesis") {
        this.#onCloseParenthesis(options);
        --depth;
        if (depth === 0) {
          break;
        }
      } else if (
        token.tokenType === "Function" &&
        token.value === "var" &&
        options.getVariableData
      ) {
        sawVariable = true;
        const { node, value, computedValue, fallbackValue } =
          this.#parseVariable(token, text, tokenStream, options);
        functionData.push({ node, value, computedValue, fallbackValue });
      } else if (token.tokenType === "Function") {
        ++depth;
      }

      if (
        token.tokenType !== "Function" ||
        token.value !== "var" ||
        !options.getVariableData
      ) {
        functionData.push(text.substring(token.startOffset, token.endOffset));
      }

      if (token.tokenType !== "WhiteSpace") {
        tokens.push(token);
      }
    }

    return { tokens, functionData, sawComma: false, sawVariable, depth };
  }

  /**
   * Parse var() use and return a variable node to be added to the output state.
   * This will read tokens up to and including the ")" that closes the "var("
   * invocation.
   *
   * @param  {CSSToken} initialToken
   *         The "var(" token that was already seen.
   * @param  {String} text
   *         The original input text.
   * @param  {CSSLexer} tokenStream
   *         The token stream from which to read.
   * @param  {Object} options
   *         The options object in use; @see #mergeOptions.
   * @return {Object}
   *         - node: A node for the variable, with the appropriate text and
   *           title. Eg. a span with "var(--var1)" as the textContent
   *           and a title for --var1 like "--var1 = 10" or
   *           "--var1 is not set".
   *         - value: The value for the variable.
   */
  #parseVariable(initialToken, text, tokenStream, options) {
    // Handle the "var(".
    const varText = text.substring(
      initialToken.startOffset,
      initialToken.endOffset
    );
    const variableNode = this.#createNode("span", {}, varText);

    // Parse the first variable name within the parens of var().
    const { tokens, functionData, sawComma, sawVariable } =
      this.#parseMatchingParens(text, tokenStream, options, true);

    const result = sawVariable ? "" : functionData.join("");

    // Display options for the first and second argument in the var().
    const firstOpts = {};
    const secondOpts = {};

    let varData;
    let varFallbackValue;
    let varSubstitutedValue;
    let varComputedValue;

    // Get the variable value if it is in use.
    if (tokens && tokens.length === 1) {
      varData = options.getVariableData(tokens[0].text);
      const varValue =
        typeof varData.value === "string"
          ? varData.value
          : varData.registeredProperty?.initialValue;

      const varStartingStyleValue =
        typeof varData.startingStyle === "string"
          ? varData.startingStyle
          : // If the variable is not set in starting style, then it will default to either:
            // - a declaration in a "regular" rule
            // - or if there's no declaration in regular rule, to the registered property initial-value.
            varValue;

      varSubstitutedValue = options.inStartingStyleRule
        ? varStartingStyleValue
        : varValue;

      varComputedValue = varData.computedValue;
    }

    if (typeof varSubstitutedValue === "string") {
      // The variable value is valid, store the substituted value in a data attribute to
      // be reused by the variable tooltip.
      firstOpts["data-variable"] = varSubstitutedValue;
      firstOpts.class = options.matchedVariableClass;
      secondOpts.class = options.unmatchedClass;

      // Display computed value when it exists, is different from the substituted value
      // we computed, and we're not inside a starting-style rule
      if (
        !options.inStartingStyleRule &&
        typeof varComputedValue === "string" &&
        varComputedValue !== varSubstitutedValue
      ) {
        firstOpts["data-variable-computed"] = varComputedValue;
      }

      // Display starting-style value when not in a starting style rule
      if (
        !options.inStartingStyleRule &&
        typeof varData.startingStyle === "string"
      ) {
        firstOpts["data-starting-style-variable"] = varData.startingStyle;
      }

      if (varData.registeredProperty) {
        const { initialValue, syntax, inherits } = varData.registeredProperty;
        firstOpts["data-registered-property-initial-value"] = initialValue;
        firstOpts["data-registered-property-syntax"] = syntax;
        // createNode does not handle `false`, let's stringify the boolean.
        firstOpts["data-registered-property-inherits"] = `${inherits}`;
      }
    } else {
      // The variable is not set and does not have an initial value, mark it unmatched.
      firstOpts.class = options.unmatchedClass;

      // Get the variable name.
      const varName = text.substring(
        tokens[0].startOffset,
        tokens[0].endOffset
      );
      firstOpts["data-variable"] = STYLE_INSPECTOR_L10N.getFormatStr(
        "rule.variableUnset",
        varName
      );
    }

    variableNode.appendChild(this.#createNode("span", firstOpts, result));

    // If we saw a ",", then append it and show the remainder using
    // the correct highlighting.
    if (sawComma) {
      variableNode.appendChild(this.#doc.createTextNode(","));

      // Parse the text up until the close paren, being sure to
      // disable the special case for filter.
      const subOptions = Object.assign({}, options);
      subOptions.expectFilter = false;
      const saveParsed = this.#parsed;
      const savedStack = this.#stack;
      this.#parsed = [];
      this.#stack = [];
      const rest = this.#doParse(text, subOptions, tokenStream, true);
      this.#parsed = saveParsed;
      this.#stack = savedStack;

      const span = this.#createNode("span", secondOpts);
      span.appendChild(rest);
      varFallbackValue = span.textContent;
      variableNode.appendChild(span);
    }
    variableNode.appendChild(this.#doc.createTextNode(")"));

    return {
      node: variableNode,
      value: varSubstitutedValue,
      computedValue: varComputedValue,
      fallbackValue: varFallbackValue,
    };
  }

  /**
   * The workhorse for @see #parse. This parses some CSS text,
   * stopping at EOF; or optionally when an umatched close paren is
   * seen.
   *
   * @param  {String} text
   *         The original input text.
   * @param  {Object} options
   *         The options object in use; @see #mergeOptions.
   * @param  {CSSLexer} tokenStream
   *         The token stream from which to read
   * @param  {Boolean} stopAtCloseParen
   *         If true, stop at an umatched close paren.
   * @return {DocumentFragment}
   *         A document fragment.
   */
  // eslint-disable-next-line complexity
  #doParse(text, options, tokenStream, stopAtCloseParen) {
    let fontFamilyNameParts = [];
    let previousWasBang = false;

    const colorOK = () => {
      return (
        options.supportsColor ||
        ((options.expectFilter || options.isVariable) &&
          this.#stack.length !== 0 &&
          this.#stack.at(-1).isColorTakingFunction)
      );
    };

    const angleOK = function (angle) {
      return new angleUtils.CssAngle(angle).valid;
    };

    let spaceNeeded = false;
    let done = false;

    while (!done) {
      const token = tokenStream.nextToken();
      if (!token) {
        break;
      }
      const lowerCaseTokenText = token.text?.toLowerCase();

      if (token.tokenType === "Comment") {
        // This doesn't change spaceNeeded, because we didn't emit
        // anything to the output.
        continue;
      }

      switch (token.tokenType) {
        case "Function": {
          const functionName = token.value;
          const lowerCaseFunctionName = functionName.toLowerCase();

          const isColorTakingFunction = COLOR_TAKING_FUNCTIONS.has(
            lowerCaseFunctionName
          );

          this.#stack.push({
            lowerCaseFunctionName,
            functionName,
            isColorTakingFunction,
            // The position of the function separators ("," or "/") in the `parts` property
            separatorIndexes: [],
            // The parsed parts of the function that will be rendered on screen.
            // This can hold both simple strings and DOMNodes.
            parts: [],
          });

          if (
            isColorTakingFunction ||
            ANGLE_TAKING_FUNCTIONS.has(lowerCaseFunctionName)
          ) {
            // The function can accept a color or an angle argument, and we know
            // it isn't special in some other way. So, we let it
            // through to the ordinary parsing loop so that the value
            // can be handled in a single place.
            this.#appendTextNode(
              text.substring(token.startOffset, token.endOffset)
            );
          } else if (
            lowerCaseFunctionName === "var" &&
            options.getVariableData
          ) {
            const {
              node: variableNode,
              value,
              computedValue,
            } = this.#parseVariable(token, text, tokenStream, options);

            const variableValue = computedValue ?? value;
            // InspectorUtils.isValidCSSColor returns true for `light-dark()` function,
            // but `#isValidColor` returns false. As the latter is used in #appendColor,
            // we need to check that both functions return true.
            const colorObj =
              value &&
              colorOK() &&
              InspectorUtils.isValidCSSColor(variableValue)
                ? new colorUtils.CssColor(variableValue)
                : null;

            if (colorObj && this.#isValidColor(colorObj)) {
              const colorFunctionEntry = this.#stack.findLast(
                entry => entry.isColorTakingFunction
              );
              this.#appendColor(variableValue, {
                ...options,
                colorObj,
                variableContainer: variableNode,
                colorFunction: colorFunctionEntry?.functionName,
              });
            } else {
              this.#append(variableNode);
            }
          } else {
            const {
              functionData,
              sawVariable,
              tokens: functionArgTokens,
              depth,
            } = this.#parseMatchingParens(text, tokenStream, options);

            if (sawVariable) {
              const computedFunctionText =
                functionName +
                "(" +
                functionData
                  .map(data => {
                    if (typeof data === "string") {
                      return data;
                    }
                    return (
                      data.computedValue ?? data.value ?? data.fallbackValue
                    );
                  })
                  .join("") +
                ")";
              if (
                colorOK() &&
                InspectorUtils.isValidCSSColor(computedFunctionText)
              ) {
                const colorFunctionEntry = this.#stack.findLast(
                  entry => entry.isColorTakingFunction
                );

                this.#appendColor(computedFunctionText, {
                  ...options,
                  colorFunction: colorFunctionEntry?.functionName,
                  valueParts: [
                    functionName,
                    "(",
                    ...functionData.map(data => data.node || data),
                    ")",
                  ],
                });
              } else {
                // If function contains variable, we need to add both strings
                // and nodes.
                this.#appendTextNode(functionName + "(");
                for (const data of functionData) {
                  if (typeof data === "string") {
                    this.#appendTextNode(data);
                  } else if (data) {
                    this.#append(data.node);
                  }
                }
                this.#appendTextNode(")");
              }
            } else {
              // If no variable in function, join the text together and add
              // to DOM accordingly.
              const functionText =
                functionName +
                "(" +
                functionData.join("") +
                // only append closing parenthesis if the authored text actually had it
                // In such case, we should probably indicate that there's a "syntax error"
                // See Bug 1891461.
                (depth == 0 ? ")" : "");

              if (lowerCaseFunctionName === "url" && options.urlClass) {
                // url() with quoted strings are not mapped as UnquotedUrl,
                // instead, we get a "Function" token with "url" function name,
                // and later, a "QuotedString" token, which contains the actual URL.
                let url;
                for (const argToken of functionArgTokens) {
                  if (argToken.tokenType === "QuotedString") {
                    url = argToken.value;
                    break;
                  }
                }

                if (url !== undefined) {
                  this.#appendURL(functionText, url, options);
                } else {
                  this.#appendTextNode(functionText);
                }
              } else if (
                options.expectCubicBezier &&
                lowerCaseFunctionName === "cubic-bezier"
              ) {
                this.#appendCubicBezier(functionText, options);
              } else if (
                options.expectLinearEasing &&
                lowerCaseFunctionName === "linear"
              ) {
                this.#appendLinear(functionText, options);
              } else if (
                colorOK() &&
                InspectorUtils.isValidCSSColor(functionText)
              ) {
                const colorFunctionEntry = this.#stack.findLast(
                  entry => entry.isColorTakingFunction
                );
                this.#appendColor(functionText, {
                  ...options,
                  colorFunction: colorFunctionEntry?.functionName,
                });
              } else if (
                options.expectShape &&
                BASIC_SHAPE_FUNCTIONS.has(lowerCaseFunctionName)
              ) {
                this.#appendShape(functionText, options);
              } else {
                this.#appendTextNode(functionText);
              }
            }
          }
          break;
        }

        case "Ident":
          if (
            options.expectCubicBezier &&
            BEZIER_KEYWORDS.has(lowerCaseTokenText)
          ) {
            this.#appendCubicBezier(token.text, options);
          } else if (
            options.expectLinearEasing &&
            lowerCaseTokenText == "linear"
          ) {
            this.#appendLinear(token.text, options);
          } else if (this.#isDisplayFlex(text, token, options)) {
            this.#appendDisplayWithHighlighterToggle(
              token.text,
              options.flexClass
            );
          } else if (this.#isDisplayGrid(text, token, options)) {
            this.#appendDisplayWithHighlighterToggle(
              token.text,
              options.gridClass
            );
          } else if (colorOK() && InspectorUtils.isValidCSSColor(token.text)) {
            const colorFunctionEntry = this.#stack.findLast(
              entry => entry.isColorTakingFunction
            );
            this.#appendColor(token.text, {
              ...options,
              colorFunction: colorFunctionEntry?.functionName,
            });
          } else if (angleOK(token.text)) {
            this.#appendAngle(token.text, options);
          } else if (options.expectFont && !previousWasBang) {
            // We don't append the identifier if the previous token
            // was equal to '!', since in that case we expect the
            // identifier to be equal to 'important'.
            fontFamilyNameParts.push(token.text);
          } else {
            this.#appendTextNode(
              text.substring(token.startOffset, token.endOffset)
            );
          }
          break;

        case "IDHash":
        case "Hash": {
          const original = text.substring(token.startOffset, token.endOffset);
          if (colorOK() && InspectorUtils.isValidCSSColor(original)) {
            if (spaceNeeded) {
              // Insert a space to prevent token pasting when a #xxx
              // color is changed to something like rgb(...).
              this.#appendTextNode(" ");
            }
            const colorFunctionEntry = this.#stack.findLast(
              entry => entry.isColorTakingFunction
            );
            this.#appendColor(original, {
              ...options,
              colorFunction: colorFunctionEntry?.functionName,
            });
          } else {
            this.#appendTextNode(original);
          }
          break;
        }
        case "Dimension":
          const value = text.substring(token.startOffset, token.endOffset);
          if (angleOK(value)) {
            this.#appendAngle(value, options);
          } else {
            this.#appendTextNode(value);
          }
          break;
        case "UnquotedUrl":
        case "BadUrl":
          this.#appendURL(
            text.substring(token.startOffset, token.endOffset),
            token.value,
            options
          );
          break;

        case "QuotedString":
          if (options.expectFont) {
            fontFamilyNameParts.push(
              text.substring(token.startOffset, token.endOffset)
            );
          } else {
            this.#appendTextNode(
              text.substring(token.startOffset, token.endOffset)
            );
          }
          break;

        case "WhiteSpace":
          if (options.expectFont) {
            fontFamilyNameParts.push(" ");
          } else {
            this.#appendTextNode(
              text.substring(token.startOffset, token.endOffset)
            );
          }
          break;

        case "ParenthesisBlock":
          this.#stack.push({
            isParenthesis: true,
            separatorIndexes: [],
            // The parsed parts of the function that will be rendered on screen.
            // This can hold both simple strings and DOMNodes.
            parts: [],
          });
          this.#appendTextNode(
            text.substring(token.startOffset, token.endOffset)
          );
          break;

        case "CloseParenthesis":
          this.#onCloseParenthesis(options);

          if (stopAtCloseParen && this.#stack.length === 0) {
            done = true;
            break;
          }

          this.#appendTextNode(
            text.substring(token.startOffset, token.endOffset)
          );
          break;

        case "Comma":
        case "Delim":
          if (
            (token.tokenType === "Comma" || token.text === "!") &&
            options.expectFont &&
            fontFamilyNameParts.length !== 0
          ) {
            this.#appendFontFamily(fontFamilyNameParts.join(""), options);
            fontFamilyNameParts = [];
          }

          // Add separator for the current function
          if (this.#stack.length) {
            this.#appendTextNode(token.text);
            const entry = this.#stack.at(-1);
            entry.separatorIndexes.push(entry.parts.length - 1);
            break;
          }

        // falls through
        default:
          this.#appendTextNode(
            text.substring(token.startOffset, token.endOffset)
          );
          break;
      }

      // If this token might possibly introduce token pasting when
      // color-cycling, require a space.
      spaceNeeded =
        token.tokenType === "Ident" ||
        token.tokenType === "AtKeyword" ||
        token.tokenType === "IDHash" ||
        token.tokenType === "Hash" ||
        token.tokenType === "Number" ||
        token.tokenType === "Dimension" ||
        token.tokenType === "Percentage" ||
        token.tokenType === "Dimension";
      previousWasBang = token.tokenType === "Delim" && token.text === "!";
    }

    if (options.expectFont && fontFamilyNameParts.length !== 0) {
      this.#appendFontFamily(fontFamilyNameParts.join(""), options);
    }

    // We might never encounter a matching closing parenthesis for a function and still
    // have a "valid" value (e.g. `background: linear-gradient(90deg, red, blue"`)
    // In such case, go through the stack and handle each items until we have nothing left.
    if (this.#stack.length) {
      while (this.#stack.length !== 0) {
        this.#onCloseParenthesis(options);
      }
    }

    let result = this.#toDOM();

    if (options.expectFilter && !options.filterSwatch) {
      result = this.#wrapFilter(text, options, result);
    }

    return result;
  }

  #onCloseParenthesis(options) {
    if (!this.#stack.length) {
      return;
    }

    const stackEntry = this.#stack.at(-1);
    if (
      stackEntry.lowerCaseFunctionName === "light-dark" &&
      typeof options.isDarkColorScheme === "boolean" &&
      // light-dark takes exactly two parameters, so if we don't get exactly 1 separator
      // at this point, that means that the value is valid at parse time, but is invalid
      // at computed value time.
      // TODO: We might want to add a class to indicate that this is invalid at computed
      // value time (See Bug 1910845)
      stackEntry.separatorIndexes.length === 1
    ) {
      const stackEntryParts = this.#getCurrentStackParts();
      const separatorIndex = stackEntry.separatorIndexes[0];
      let startIndex;
      let endIndex;
      if (options.isDarkColorScheme) {
        // If we're using a dark color scheme, we want to mark the first param as
        // not used.

        // The first "part" is `light-dark(`, so we can start after that.
        // We want to filter out white space character before the first parameter
        for (startIndex = 1; startIndex < separatorIndex; startIndex++) {
          const part = stackEntryParts[startIndex];
          if (typeof part !== "string" || part.trim() !== "") {
            break;
          }
        }

        // same for the end of the parameter, we want to filter out whitespaces
        // after the parameter and before the comma
        for (
          endIndex = separatorIndex - 1;
          endIndex >= startIndex;
          endIndex--
        ) {
          const part = stackEntryParts[endIndex];
          if (typeof part !== "string" || part.trim() !== "") {
            // We found a non-whitespace part, we need to include it, so increment the endIndex
            endIndex++;
            break;
          }
        }
      } else {
        // If we're not using a dark color scheme, we want to mark the second param as
        // not used.

        // We want to filter out white space character after the comma and before the
        // second parameter
        for (
          startIndex = separatorIndex + 1;
          startIndex < stackEntryParts.length;
          startIndex++
        ) {
          const part = stackEntryParts[startIndex];
          if (typeof part !== "string" || part.trim() !== "") {
            break;
          }
        }

        // same for the end of the parameter, we want to filter out whitespaces
        // after the parameter and before the closing parenthesis (which is not yet
        // included in stackEntryParts)
        for (
          endIndex = stackEntryParts.length - 1;
          endIndex > separatorIndex;
          endIndex--
        ) {
          const part = stackEntryParts[endIndex];
          if (typeof part !== "string" || part.trim() !== "") {
            // We found a non-whitespace part, we need to include it, so increment the endIndex
            endIndex++;
            break;
          }
        }
      }

      const parts = stackEntryParts.slice(startIndex, endIndex);

      // If the item we need to mark is already an element (e.g. a parsed color),
      // just add a class to it.
      if (parts.length === 1 && Element.isInstance(parts[0])) {
        parts[0].classList.add(options.unmatchedClass);
      } else {
        // Otherwise, we need to wrap our parts into a specific element so we can
        // style them
        const node = this.#createNode("span", {
          class: options.unmatchedClass,
        });
        node.append(...parts);
        stackEntryParts.splice(startIndex, parts.length, node);
      }
    }

    // Our job is done here, pop last stack entry
    const { parts } = this.#stack.pop();
    // Put all the parts in the "new" last stack, or the main parsed array if there
    // is no more entry in the stack
    this.#getCurrentStackParts().push(...parts);
  }

  /**
   * Parse a string.
   *
   * @param  {String} text
   *         Text to parse.
   * @param  {Object} [options]
   *         Options object. For valid options and default values see
   *         #mergeOptions().
   * @return {DocumentFragment}
   *         A document fragment.
   */
  #parse(text, options = {}) {
    text = text.trim();
    this.#parsed.length = 0;
    this.#stack.length = 0;

    const tokenStream = new InspectorCSSParserWrapper(text);
    return this.#doParse(text, options, tokenStream, false);
  }

  /**
   * Returns true if it's a "display: [inline-]flex" token.
   *
   * @param  {String} text
   *         The parsed text.
   * @param  {Object} token
   *         The parsed token.
   * @param  {Object} options
   *         The options given to #parse.
   */
  #isDisplayFlex(text, token, options) {
    return (
      options.expectDisplay &&
      (token.text === "flex" || token.text === "inline-flex")
    );
  }

  /**
   * Returns true if it's a "display: [inline-]grid" token.
   *
   * @param  {String} text
   *         The parsed text.
   * @param  {Object} token
   *         The parsed token.
   * @param  {Object} options
   *         The options given to #parse.
   */
  #isDisplayGrid(text, token, options) {
    return (
      options.expectDisplay &&
      (token.text === "grid" || token.text === "inline-grid")
    );
  }

  /**
   * Append a cubic-bezier timing function value to the output
   *
   * @param {String} bezier
   *        The cubic-bezier timing function
   * @param {Object} options
   *        Options object. For valid options and default values see
   *        #mergeOptions()
   */
  #appendCubicBezier(bezier, options) {
    const container = this.#createNode("span", {
      "data-bezier": bezier,
    });

    if (options.bezierSwatchClass) {
      const swatch = this.#createNode("span", {
        class: options.bezierSwatchClass,
        tabindex: "0",
        role: "button",
      });
      container.appendChild(swatch);
    }

    const value = this.#createNode(
      "span",
      {
        class: options.bezierClass,
      },
      bezier
    );

    container.appendChild(value);
    this.#append(container);
  }

  #appendLinear(text, options) {
    const container = this.#createNode("span", {
      "data-linear": text,
    });

    if (options.linearEasingSwatchClass) {
      const swatch = this.#createNode("span", {
        class: options.linearEasingSwatchClass,
        tabindex: "0",
        role: "button",
        "data-linear": text,
      });
      container.appendChild(swatch);
    }

    const value = this.#createNode(
      "span",
      {
        class: options.linearEasingClass,
      },
      text
    );

    container.appendChild(value);
    this.#append(container);
  }

  /**
   * Append a Flexbox|Grid highlighter toggle icon next to the value in a
   * "display: [inline-]flex" or "display: [inline-]grid" declaration.
   *
   * @param {String} text
   *        The text value to append
   * @param {String} toggleButtonClassName
   *        The class name for the toggle button.
   *        If not passed/empty, the toggle button won't be created.
   */
  #appendDisplayWithHighlighterToggle(text, toggleButtonClassName) {
    const container = this.#createNode("span", {});

    if (toggleButtonClassName) {
      const toggleButton = this.#createNode("button", {
        class: toggleButtonClassName,
      });
      container.append(toggleButton);
    }

    const value = this.#createNode("span", {}, text);
    container.append(value);
    this.#append(container);
  }

  /**
   * Append a CSS shapes highlighter toggle next to the value, and parse the value
   * into spans, each containing a point that can be hovered over.
   *
   * @param {String} shape
   *        The shape text value to append
   * @param {Object} options
   *        Options object. For valid options and default values see
   *        #mergeOptions()
   */
  #appendShape(shape, options) {
    const shapeTypes = [
      {
        prefix: "polygon(",
        coordParser: this.#addPolygonPointNodes.bind(this),
      },
      {
        prefix: "circle(",
        coordParser: this.#addCirclePointNodes.bind(this),
      },
      {
        prefix: "ellipse(",
        coordParser: this.#addEllipsePointNodes.bind(this),
      },
      {
        prefix: "inset(",
        coordParser: this.#addInsetPointNodes.bind(this),
      },
    ];

    const container = this.#createNode("span", {});

    const toggleButton = this.#createNode("button", {
      class: options.shapeSwatchClass,
    });

    const lowerCaseShape = shape.toLowerCase();
    for (const { prefix, coordParser } of shapeTypes) {
      if (lowerCaseShape.includes(prefix)) {
        const coordsBegin = prefix.length;
        const coordsEnd = shape.lastIndexOf(")");
        let valContainer = this.#createNode("span", {
          class: options.shapeClass,
        });

        container.appendChild(toggleButton);

        appendText(valContainer, shape.substring(0, coordsBegin));

        const coordsString = shape.substring(coordsBegin, coordsEnd);
        valContainer = coordParser(coordsString, valContainer);

        appendText(valContainer, shape.substring(coordsEnd));
        container.appendChild(valContainer);
      }
    }

    this.#append(container);
  }

  /**
   * Parse the given polygon coordinates and create a span for each coordinate pair,
   * adding it to the given container node.
   *
   * @param {String} coords
   *        The string of coordinate pairs.
   * @param {Node} container
   *        The node to which spans containing points are added.
   * @returns {Node} The container to which spans have been added.
   */
  // eslint-disable-next-line complexity
  #addPolygonPointNodes(coords, container) {
    const tokenStream = new InspectorCSSParserWrapper(coords);
    let token = tokenStream.nextToken();
    let coord = "";
    let i = 0;
    let depth = 0;
    let isXCoord = true;
    let fillRule = false;
    let coordNode = this.#createNode("span", {
      class: "inspector-shape-point",
      "data-point": `${i}`,
    });

    while (token) {
      if (token.tokenType === "Comma") {
        // Comma separating coordinate pairs; add coordNode to container and reset vars
        if (!isXCoord) {
          // Y coord not added to coordNode yet
          const node = this.#createNode(
            "span",
            {
              class: "inspector-shape-point",
              "data-point": `${i}`,
              "data-pair": isXCoord ? "x" : "y",
            },
            coord
          );
          coordNode.appendChild(node);
          coord = "";
          isXCoord = !isXCoord;
        }

        if (fillRule) {
          // If the last text added was a fill-rule, do not increment i.
          fillRule = false;
        } else {
          container.appendChild(coordNode);
          i++;
        }
        appendText(
          container,
          coords.substring(token.startOffset, token.endOffset)
        );
        coord = "";
        depth = 0;
        isXCoord = true;
        coordNode = this.#createNode("span", {
          class: "inspector-shape-point",
          "data-point": `${i}`,
        });
      } else if (token.tokenType === "ParenthesisBlock") {
        depth++;
        coord += coords.substring(token.startOffset, token.endOffset);
      } else if (token.tokenType === "CloseParenthesis") {
        depth--;
        coord += coords.substring(token.startOffset, token.endOffset);
      } else if (token.tokenType === "WhiteSpace" && coord === "") {
        // Whitespace at beginning of coord; add to container
        appendText(
          container,
          coords.substring(token.startOffset, token.endOffset)
        );
      } else if (token.tokenType === "WhiteSpace" && depth === 0) {
        // Whitespace signifying end of coord
        const node = this.#createNode(
          "span",
          {
            class: "inspector-shape-point",
            "data-point": `${i}`,
            "data-pair": isXCoord ? "x" : "y",
          },
          coord
        );
        coordNode.appendChild(node);
        appendText(
          coordNode,
          coords.substring(token.startOffset, token.endOffset)
        );
        coord = "";
        isXCoord = !isXCoord;
      } else if (
        token.tokenType === "Number" ||
        token.tokenType === "Dimension" ||
        token.tokenType === "Percentage" ||
        token.tokenType === "Function"
      ) {
        if (isXCoord && coord && depth === 0) {
          // Whitespace is not necessary between x/y coords.
          const node = this.#createNode(
            "span",
            {
              class: "inspector-shape-point",
              "data-point": `${i}`,
              "data-pair": "x",
            },
            coord
          );
          coordNode.appendChild(node);
          isXCoord = false;
          coord = "";
        }

        coord += coords.substring(token.startOffset, token.endOffset);
        if (token.tokenType === "Function") {
          depth++;
        }
      } else if (
        token.tokenType === "Ident" &&
        (token.text === "nonzero" || token.text === "evenodd")
      ) {
        // A fill-rule (nonzero or evenodd).
        appendText(
          container,
          coords.substring(token.startOffset, token.endOffset)
        );
        fillRule = true;
      } else {
        coord += coords.substring(token.startOffset, token.endOffset);
      }
      token = tokenStream.nextToken();
    }

    // Add coords if any are left over
    if (coord) {
      const node = this.#createNode(
        "span",
        {
          class: "inspector-shape-point",
          "data-point": `${i}`,
          "data-pair": isXCoord ? "x" : "y",
        },
        coord
      );
      coordNode.appendChild(node);
      container.appendChild(coordNode);
    }
    return container;
  }

  /**
   * Parse the given circle coordinates and populate the given container appropriately
   * with a separate span for the center point.
   *
   * @param {String} coords
   *        The circle definition.
   * @param {Node} container
   *        The node to which the definition is added.
   * @returns {Node} The container to which the definition has been added.
   */
  // eslint-disable-next-line complexity
  #addCirclePointNodes(coords, container) {
    const tokenStream = new InspectorCSSParserWrapper(coords);
    let token = tokenStream.nextToken();
    let depth = 0;
    let coord = "";
    let point = "radius";
    const centerNode = this.#createNode("span", {
      class: "inspector-shape-point",
      "data-point": "center",
    });
    while (token) {
      if (token.tokenType === "ParenthesisBlock") {
        depth++;
        coord += coords.substring(token.startOffset, token.endOffset);
      } else if (token.tokenType === "CloseParenthesis") {
        depth--;
        coord += coords.substring(token.startOffset, token.endOffset);
      } else if (token.tokenType === "WhiteSpace" && coord === "") {
        // Whitespace at beginning of coord; add to container
        appendText(
          container,
          coords.substring(token.startOffset, token.endOffset)
        );
      } else if (
        token.tokenType === "WhiteSpace" &&
        point === "radius" &&
        depth === 0
      ) {
        // Whitespace signifying end of radius
        const node = this.#createNode(
          "span",
          {
            class: "inspector-shape-point",
            "data-point": "radius",
          },
          coord
        );
        container.appendChild(node);
        appendText(
          container,
          coords.substring(token.startOffset, token.endOffset)
        );
        point = "cx";
        coord = "";
        depth = 0;
      } else if (token.tokenType === "WhiteSpace" && depth === 0) {
        // Whitespace signifying end of cx/cy
        const node = this.#createNode(
          "span",
          {
            class: "inspector-shape-point",
            "data-point": "center",
            "data-pair": point === "cx" ? "x" : "y",
          },
          coord
        );
        centerNode.appendChild(node);
        appendText(
          centerNode,
          coords.substring(token.startOffset, token.endOffset)
        );
        point = point === "cx" ? "cy" : "cx";
        coord = "";
        depth = 0;
      } else if (token.tokenType === "Ident" && token.text === "at") {
        // "at"; Add radius to container if not already done so
        if (point === "radius" && coord) {
          const node = this.#createNode(
            "span",
            {
              class: "inspector-shape-point",
              "data-point": "radius",
            },
            coord
          );
          container.appendChild(node);
        }
        appendText(
          container,
          coords.substring(token.startOffset, token.endOffset)
        );
        point = "cx";
        coord = "";
        depth = 0;
      } else if (
        token.tokenType === "Number" ||
        token.tokenType === "Dimension" ||
        token.tokenType === "Percentage" ||
        token.tokenType === "Function"
      ) {
        if (point === "cx" && coord && depth === 0) {
          // Center coords don't require whitespace between x/y. So if current point is
          // cx, we have the cx coord, and depth is 0, then this token is actually cy.
          // Add cx to centerNode and set point to cy.
          const node = this.#createNode(
            "span",
            {
              class: "inspector-shape-point",
              "data-point": "center",
              "data-pair": "x",
            },
            coord
          );
          centerNode.appendChild(node);
          point = "cy";
          coord = "";
        }

        coord += coords.substring(token.startOffset, token.endOffset);
        if (token.tokenType === "Function") {
          depth++;
        }
      } else {
        coord += coords.substring(token.startOffset, token.endOffset);
      }
      token = tokenStream.nextToken();
    }

    // Add coords if any are left over.
    if (coord) {
      if (point === "radius") {
        const node = this.#createNode(
          "span",
          {
            class: "inspector-shape-point",
            "data-point": "radius",
          },
          coord
        );
        container.appendChild(node);
      } else {
        const node = this.#createNode(
          "span",
          {
            class: "inspector-shape-point",
            "data-point": "center",
            "data-pair": point === "cx" ? "x" : "y",
          },
          coord
        );
        centerNode.appendChild(node);
      }
    }

    if (centerNode.textContent) {
      container.appendChild(centerNode);
    }
    return container;
  }

  /**
   * Parse the given ellipse coordinates and populate the given container appropriately
   * with a separate span for each point
   *
   * @param {String} coords
   *        The ellipse definition.
   * @param {Node} container
   *        The node to which the definition is added.
   * @returns {Node} The container to which the definition has been added.
   */
  // eslint-disable-next-line complexity
  #addEllipsePointNodes(coords, container) {
    const tokenStream = new InspectorCSSParserWrapper(coords);
    let token = tokenStream.nextToken();
    let depth = 0;
    let coord = "";
    let point = "rx";
    const centerNode = this.#createNode("span", {
      class: "inspector-shape-point",
      "data-point": "center",
    });
    while (token) {
      if (token.tokenType === "ParenthesisBlock") {
        depth++;
        coord += coords.substring(token.startOffset, token.endOffset);
      } else if (token.tokenType === "CloseParenthesis") {
        depth--;
        coord += coords.substring(token.startOffset, token.endOffset);
      } else if (token.tokenType === "WhiteSpace" && coord === "") {
        // Whitespace at beginning of coord; add to container
        appendText(
          container,
          coords.substring(token.startOffset, token.endOffset)
        );
      } else if (token.tokenType === "WhiteSpace" && depth === 0) {
        if (point === "rx" || point === "ry") {
          // Whitespace signifying end of rx/ry
          const node = this.#createNode(
            "span",
            {
              class: "inspector-shape-point",
              "data-point": point,
            },
            coord
          );
          container.appendChild(node);
          appendText(
            container,
            coords.substring(token.startOffset, token.endOffset)
          );
          point = point === "rx" ? "ry" : "cx";
          coord = "";
          depth = 0;
        } else {
          // Whitespace signifying end of cx/cy
          const node = this.#createNode(
            "span",
            {
              class: "inspector-shape-point",
              "data-point": "center",
              "data-pair": point === "cx" ? "x" : "y",
            },
            coord
          );
          centerNode.appendChild(node);
          appendText(
            centerNode,
            coords.substring(token.startOffset, token.endOffset)
          );
          point = point === "cx" ? "cy" : "cx";
          coord = "";
          depth = 0;
        }
      } else if (token.tokenType === "Ident" && token.text === "at") {
        // "at"; Add radius to container if not already done so
        if (point === "ry" && coord) {
          const node = this.#createNode(
            "span",
            {
              class: "inspector-shape-point",
              "data-point": "ry",
            },
            coord
          );
          container.appendChild(node);
        }
        appendText(
          container,
          coords.substring(token.startOffset, token.endOffset)
        );
        point = "cx";
        coord = "";
        depth = 0;
      } else if (
        token.tokenType === "Number" ||
        token.tokenType === "Dimension" ||
        token.tokenType === "Percentage" ||
        token.tokenType === "Function"
      ) {
        if (point === "rx" && coord && depth === 0) {
          // Radius coords don't require whitespace between x/y.
          const node = this.#createNode(
            "span",
            {
              class: "inspector-shape-point",
              "data-point": "rx",
            },
            coord
          );
          container.appendChild(node);
          point = "ry";
          coord = "";
        }
        if (point === "cx" && coord && depth === 0) {
          // Center coords don't require whitespace between x/y.
          const node = this.#createNode(
            "span",
            {
              class: "inspector-shape-point",
              "data-point": "center",
              "data-pair": "x",
            },
            coord
          );
          centerNode.appendChild(node);
          point = "cy";
          coord = "";
        }

        coord += coords.substring(token.startOffset, token.endOffset);
        if (token.tokenType === "Function") {
          depth++;
        }
      } else {
        coord += coords.substring(token.startOffset, token.endOffset);
      }
      token = tokenStream.nextToken();
    }

    // Add coords if any are left over.
    if (coord) {
      if (point === "rx" || point === "ry") {
        const node = this.#createNode(
          "span",
          {
            class: "inspector-shape-point",
            "data-point": point,
          },
          coord
        );
        container.appendChild(node);
      } else {
        const node = this.#createNode(
          "span",
          {
            class: "inspector-shape-point",
            "data-point": "center",
            "data-pair": point === "cx" ? "x" : "y",
          },
          coord
        );
        centerNode.appendChild(node);
      }
    }

    if (centerNode.textContent) {
      container.appendChild(centerNode);
    }
    return container;
  }

  /**
   * Parse the given inset coordinates and populate the given container appropriately.
   *
   * @param {String} coords
   *        The inset definition.
   * @param {Node} container
   *        The node to which the definition is added.
   * @returns {Node} The container to which the definition has been added.
   */
  // eslint-disable-next-line complexity
  #addInsetPointNodes(coords, container) {
    const insetPoints = ["top", "right", "bottom", "left"];
    const tokenStream = new InspectorCSSParserWrapper(coords);
    let token = tokenStream.nextToken();
    let depth = 0;
    let coord = "";
    let i = 0;
    let round = false;
    // nodes is an array containing all the coordinate spans. otherText is an array of
    // arrays, each containing the text that should be inserted into container before
    // the node with the same index. i.e. all elements of otherText[i] is inserted
    // into container before nodes[i].
    const nodes = [];
    const otherText = [[]];

    while (token) {
      if (round) {
        // Everything that comes after "round" should just be plain text
        otherText[i].push(coords.substring(token.startOffset, token.endOffset));
      } else if (token.tokenType === "ParenthesisBlock") {
        depth++;
        coord += coords.substring(token.startOffset, token.endOffset);
      } else if (token.tokenType === "CloseParenthesis") {
        depth--;
        coord += coords.substring(token.startOffset, token.endOffset);
      } else if (token.tokenType === "WhiteSpace" && coord === "") {
        // Whitespace at beginning of coord; add to container
        otherText[i].push(coords.substring(token.startOffset, token.endOffset));
      } else if (token.tokenType === "WhiteSpace" && depth === 0) {
        // Whitespace signifying end of coord; create node and push to nodes
        const node = this.#createNode(
          "span",
          {
            class: "inspector-shape-point",
          },
          coord
        );
        nodes.push(node);
        i++;
        coord = "";
        otherText[i] = [coords.substring(token.startOffset, token.endOffset)];
        depth = 0;
      } else if (
        token.tokenType === "Number" ||
        token.tokenType === "Dimension" ||
        token.tokenType === "Percentage" ||
        token.tokenType === "Function"
      ) {
        if (coord && depth === 0) {
          // Inset coords don't require whitespace between each coord.
          const node = this.#createNode(
            "span",
            {
              class: "inspector-shape-point",
            },
            coord
          );
          nodes.push(node);
          i++;
          coord = "";
          otherText[i] = [];
        }

        coord += coords.substring(token.startOffset, token.endOffset);
        if (token.tokenType === "Function") {
          depth++;
        }
      } else if (token.tokenType === "Ident" && token.text === "round") {
        if (coord && depth === 0) {
          // Whitespace is not necessary before "round"; create a new node for the coord
          const node = this.#createNode(
            "span",
            {
              class: "inspector-shape-point",
            },
            coord
          );
          nodes.push(node);
          i++;
          coord = "";
          otherText[i] = [];
        }
        round = true;
        otherText[i].push(coords.substring(token.startOffset, token.endOffset));
      } else {
        coord += coords.substring(token.startOffset, token.endOffset);
      }
      token = tokenStream.nextToken();
    }

    // Take care of any leftover text
    if (coord) {
      if (round) {
        otherText[i].push(coord);
      } else {
        const node = this.#createNode(
          "span",
          {
            class: "inspector-shape-point",
          },
          coord
        );
        nodes.push(node);
      }
    }

    // insetPoints contains the 4 different possible inset points in the order they are
    // defined. By taking the modulo of the index in insetPoints with the number of nodes,
    // we can get which node represents each point (e.g. if there is only 1 node, it
    // represents all 4 points). The exception is "left" when there are 3 nodes. In that
    // case, it is nodes[1] that represents the left point rather than nodes[0].
    for (let j = 0; j < 4; j++) {
      const point = insetPoints[j];
      const nodeIndex =
        point === "left" && nodes.length === 3 ? 1 : j % nodes.length;
      nodes[nodeIndex].classList.add(point);
    }

    nodes.forEach((node, j) => {
      for (const text of otherText[j]) {
        appendText(container, text);
      }
      container.appendChild(node);
    });

    // Add text that comes after the last node, if any exists
    if (otherText[nodes.length]) {
      for (const text of otherText[nodes.length]) {
        appendText(container, text);
      }
    }

    return container;
  }

  /**
   * Append a angle value to the output
   *
   * @param {String} angle
   *        angle to append
   * @param {Object} options
   *        Options object. For valid options and default values see
   *        #mergeOptions()
   */
  #appendAngle(angle, options) {
    const angleObj = new angleUtils.CssAngle(angle);
    const container = this.#createNode("span", {
      "data-angle": angle,
    });

    if (options.angleSwatchClass) {
      const swatch = this.#createNode("span", {
        class: options.angleSwatchClass,
        tabindex: "0",
        role: "button",
      });
      this.#angleSwatches.set(swatch, angleObj);
      swatch.addEventListener("mousedown", this.#onAngleSwatchMouseDown);

      // Add click listener to stop event propagation when shift key is pressed
      // in order to prevent the value input to be focused.
      // Bug 711942 will add a tooltip to edit angle values and we should
      // be able to move this listener to Tooltip.js when it'll be implemented.
      swatch.addEventListener("click", function (event) {
        if (event.shiftKey) {
          event.stopPropagation();
        }
      });
      container.appendChild(swatch);
    }

    const value = this.#createNode(
      "span",
      {
        class: options.angleClass,
      },
      angle
    );

    container.appendChild(value);
    this.#append(container);
  }

  /**
   * Check if a CSS property supports a specific value.
   *
   * @param  {String} name
   *         CSS Property name to check
   * @param  {String} value
   *         CSS Property value to check
   */
  #cssPropertySupportsValue(name, value) {
    // Checking pair as a CSS declaration string to account for "!important" in value.
    const declaration = `${name}:${value}`;
    return this.#doc.defaultView.CSS.supports(declaration);
  }

  /**
   * Tests if a given colorObject output by CssColor is valid for parsing.
   * Valid means it's really a color, not any of the CssColor SPECIAL_VALUES
   * except transparent
   */
  #isValidColor(colorObj) {
    return (
      colorObj.valid &&
      (!colorObj.specialValue || colorObj.specialValue === "transparent")
    );
  }

  /**
   * Append a color to the output.
   *
   * @param {String} color
   *         Color to append
   * @param {Object} [options]
   * @param {CSSColor} options.colorObj: A css color for the passed color. Will be computed
   *         if not passed.
   * @param {DOMNode} options.variableContainer: A DOM Node that is the result of parsing
   *        a CSS variable
   * @param {String} options.colorFunction: The color function that is used to produce this color
   * @param {*} For all the other valid options and default values see #mergeOptions().
   */
  #appendColor(color, options = {}) {
    const colorObj = options.colorObj || new colorUtils.CssColor(color);

    if (this.#isValidColor(colorObj)) {
      const container = this.#createNode("span", {
        "data-color": color,
      });

      if (options.colorSwatchClass) {
        let attributes = {
          class: options.colorSwatchClass,
          style: "background-color:" + color,
        };

        // Color swatches next to values trigger the color editor everywhere aside from
        // the Computed panel where values are read-only.
        if (!options.colorSwatchReadOnly) {
          attributes = { ...attributes, tabindex: "0", role: "button" };
        }

        // The swatch is a <span> instead of a <button> intentionally. See Bug 1597125.
        // It is made keyboard accessible via `tabindex` and has keydown handlers
        // attached for pressing SPACE and RETURN in SwatchBasedEditorTooltip.js
        const swatch = this.#createNode("span", attributes);
        this.#colorSwatches.set(swatch, colorObj);
        if (options.colorFunction) {
          swatch.dataset.colorFunction = options.colorFunction;
        }
        swatch.addEventListener("mousedown", this.#onColorSwatchMouseDown);
        container.appendChild(swatch);
        container.classList.add("color-swatch-container");
      }

      let colorUnit = options.defaultColorUnit;
      if (!options.useDefaultColorUnit) {
        // If we're not being asked to convert the color to the default color type
        // specified by the user, then force the CssColor instance to be set to the type
        // of the current color.
        // Not having a type means that the default color type will be automatically used.
        colorUnit = colorUtils.classifyColor(color);
      }
      color = colorObj.toString(colorUnit);
      container.dataset.color = color;

      // Next we create the markup to show the value of the property.
      if (options.variableContainer) {
        // If we are creating a color swatch for a CSS variable we simply reuse
        // the markup created for the variableContainer.
        if (options.colorClass) {
          options.variableContainer.classList.add(options.colorClass);
        }
        container.appendChild(options.variableContainer);
      } else {
        // Otherwise we create a new element with the `color` as textContent.
        const value = this.#createNode("span", {
          class: options.colorClass,
        });
        if (options.valueParts) {
          value.append(...options.valueParts);
        } else {
          value.append(this.#doc.createTextNode(color));
        }

        container.appendChild(value);
      }

      this.#append(container);
    } else {
      this.#appendTextNode(color);
    }
  }

  /**
   * Wrap some existing nodes in a filter editor.
   *
   * @param {String} filters
   *        The full text of the "filter" property.
   * @param {object} options
   *        The options object passed to parseCssProperty().
   * @param {object} nodes
   *        Nodes created by #toDOM().
   *
   * @returns {object}
   *        A new node that supplies a filter swatch and that wraps |nodes|.
   */
  #wrapFilter(filters, options, nodes) {
    const container = this.#createNode("span", {
      "data-filters": filters,
    });

    if (options.filterSwatchClass) {
      const swatch = this.#createNode("span", {
        class: options.filterSwatchClass,
        tabindex: "0",
        role: "button",
      });
      container.appendChild(swatch);
    }

    const value = this.#createNode("span", {
      class: options.filterClass,
    });
    value.appendChild(nodes);
    container.appendChild(value);

    return container;
  }

  #onColorSwatchMouseDown = event => {
    if (!event.shiftKey) {
      return;
    }

    // Prevent click event to be fired to not show the tooltip
    event.stopPropagation();

    const swatch = event.target;
    const color = this.#colorSwatches.get(swatch);
    const val = color.nextColorUnit();

    swatch.nextElementSibling.textContent = val;
    swatch.parentNode.dataset.color = val;

    const unitChangeEvent = new swatch.ownerGlobal.CustomEvent("unit-change");
    swatch.dispatchEvent(unitChangeEvent);
  };

  #onAngleSwatchMouseDown = event => {
    if (!event.shiftKey) {
      return;
    }

    event.stopPropagation();

    const swatch = event.target;
    const angle = this.#angleSwatches.get(swatch);
    const val = angle.nextAngleUnit();

    swatch.nextElementSibling.textContent = val;

    const unitChangeEvent = new swatch.ownerGlobal.CustomEvent("unit-change");
    swatch.dispatchEvent(unitChangeEvent);
  };

  /**
   * A helper function that sanitizes a possibly-unterminated URL.
   */
  #sanitizeURL(url) {
    // Re-lex the URL and add any needed termination characters.
    const urlTokenizer = new InspectorCSSParserWrapper(url, {
      trackEOFChars: true,
    });
    // Just read until EOF; there will only be a single token.
    while (urlTokenizer.nextToken()) {
      // Nothing.
    }

    return urlTokenizer.performEOFFixup(url);
  }

  /**
   * Append a URL to the output.
   *
   * @param  {String} match
   *         Complete match that may include "url(xxx)"
   * @param  {String} url
   *         Actual URL
   * @param  {Object} [options]
   *         Options object. For valid options and default values see
   *         #mergeOptions().
   */
  #appendURL(match, url, options) {
    if (options.urlClass) {
      // Sanitize the URL. Note that if we modify the URL, we just
      // leave the termination characters. This isn't strictly
      // "as-authored", but it makes a bit more sense.
      match = this.#sanitizeURL(match);
      const urlParts = URL_REGEX.exec(match);

      // Bail out if that didn't match anything.
      if (!urlParts) {
        this.#appendTextNode(match);
        return;
      }

      const { leader, body, trailer } = urlParts.groups;

      this.#appendTextNode(leader);

      this.#appendNode(
        "a",
        {
          target: "_blank",
          class: options.urlClass,
          href: options.baseURI
            ? (URL.parse(url, options.baseURI)?.href ?? url)
            : url,
        },
        body
      );

      this.#appendTextNode(trailer);
    } else {
      this.#appendTextNode(match);
    }
  }

  /**
   * Append a font family to the output.
   *
   * @param  {String} fontFamily
   *         Font family to append
   * @param  {Object} options
   *         Options object. For valid options and default values see
   *         #mergeOptions().
   */
  #appendFontFamily(fontFamily, options) {
    let spanContents = fontFamily;
    let quoteChar = null;
    let trailingWhitespace = false;

    // Before appending the actual font-family span, we need to trim
    // down the actual contents by removing any whitespace before and
    // after, and any quotation characters in the passed string.  Any
    // such characters are preserved in the actual output, but just
    // not inside the span element.

    if (spanContents[0] === " ") {
      this.#appendTextNode(" ");
      spanContents = spanContents.slice(1);
    }

    if (spanContents[spanContents.length - 1] === " ") {
      spanContents = spanContents.slice(0, -1);
      trailingWhitespace = true;
    }

    if (spanContents[0] === "'" || spanContents[0] === '"') {
      quoteChar = spanContents[0];
    }

    if (quoteChar) {
      this.#appendTextNode(quoteChar);
      spanContents = spanContents.slice(1, -1);
    }

    this.#appendNode(
      "span",
      {
        class: options.fontFamilyClass,
      },
      spanContents
    );

    if (quoteChar) {
      this.#appendTextNode(quoteChar);
    }

    if (trailingWhitespace) {
      this.#appendTextNode(" ");
    }
  }

  /**
   * Create a node.
   *
   * @param  {String} tagName
   *         Tag type e.g. "div"
   * @param  {Object} attributes
   *         e.g. {class: "someClass", style: "cursor:pointer"};
   * @param  {String} [value]
   *         If a value is included it will be appended as a text node inside
   *         the tag. This is useful e.g. for span tags.
   * @return {Node} Newly created Node.
   */
  #createNode(tagName, attributes, value = "") {
    const node = this.#doc.createElementNS(HTML_NS, tagName);
    const attrs = Object.getOwnPropertyNames(attributes);

    for (const attr of attrs) {
      const attrValue = attributes[attr];
      if (attrValue !== null && attrValue !== undefined) {
        node.setAttribute(attr, attributes[attr]);
      }
    }

    if (value) {
      const textNode = this.#doc.createTextNode(value);
      node.appendChild(textNode);
    }

    return node;
  }

  /**
   * Create and append a node to the output.
   *
   * @param  {String} tagName
   *         Tag type e.g. "div"
   * @param  {Object} attributes
   *         e.g. {class: "someClass", style: "cursor:pointer"};
   * @param  {String} [value]
   *         If a value is included it will be appended as a text node inside
   *         the tag. This is useful e.g. for span tags.
   */
  #appendNode(tagName, attributes, value = "") {
    const node = this.#createNode(tagName, attributes, value);
    if (value.length > TRUNCATE_LENGTH_THRESHOLD) {
      node.classList.add(TRUNCATE_NODE_CLASSNAME);
    }

    this.#append(node);
  }

  /**
   * Append an element or a text node to the output.
   *
   * @param {DOMNode|String} item
   */
  #append(item) {
    this.#getCurrentStackParts().push(item);
  }

  /**
   * Append a text node to the output. If the previously output item was a text
   * node then we append the text to that node.
   *
   * @param  {String} text
   *         Text to append
   */
  #appendTextNode(text) {
    if (text.length > TRUNCATE_LENGTH_THRESHOLD) {
      // If the text is too long, force creating a node, which will add the
      // necessary classname to truncate the property correctly.
      this.#appendNode("span", {}, text);
    } else {
      this.#append(text);
    }
  }

  #getCurrentStackParts() {
    return this.#stack.at(-1)?.parts || this.#parsed;
  }

  /**
   * Take all output and append it into a single DocumentFragment.
   *
   * @return {DocumentFragment}
   *         Document Fragment
   */
  #toDOM() {
    const frag = this.#doc.createDocumentFragment();

    for (const item of this.#parsed) {
      if (typeof item === "string") {
        frag.appendChild(this.#doc.createTextNode(item));
      } else {
        frag.appendChild(item);
      }
    }

    this.#parsed.length = 0;
    this.#stack.length = 0;
    return frag;
  }

  /**
   * Merges options objects. Default values are set here.
   *
   * @param  {Object} overrides
   *         The option values to override e.g. #mergeOptions({colors: false})
   * @param {Boolean} overrides.useDefaultColorUnit: Convert colors to the default type
   *                                                 selected in the options panel.
   * @param {String} overrides.angleClass: The class to use for the angle value that follows
   *                                       the swatch.
   * @param {String} overrides.angleSwatchClass: The class to use for angle swatches.
   * @param {String} overrides.bezierClass: The class to use for the bezier value that
   *        follows the swatch.
   * @param {String} overrides.bezierSwatchClass: The class to use for bezier swatches.
   * @param {String} overrides.colorClass: The class to use for the color value that
   *        follows the swatch.
   * @param {String} overrides.colorSwatchClass: The class to use for color swatches.
   * @param {Boolean} overrides.colorSwatchReadOnly: Whether the resulting color swatch
   *        should be read-only or not. Defaults to false.
   * @param {Boolean} overrides.filterSwatch: A special case for parsing a "filter" property,
   *        causing the parser to skip the call to #wrapFilter. Used only for previewing
   *        with the filter swatch.
   * @param {String} overrides.flexClass: The class to use for the flex icon.
   * @param {String} overrides.gridClass: The class to use for the grid icon.
   * @param {String} overrides.shapeClass: The class to use for the shape value that
   *         follows the swatch.
   * @param {String} overrides.shapeSwatchClass: The class to use for the shape swatch.
   * @param {String} overrides.urlClass: The class to be used for url() links.
   * @param {String} overrides.fontFamilyClass: The class to be used for font families.
   * @param {String} overrides.unmatchedClass: The class to use for a component of
   *        a `var(…)` that is not in use.
   * @param {Boolean} overrides.supportsColor: Does the CSS property support colors?
   * @param {String} overrides.baseURI: A string used to resolve relative links.
   * @param {Function} overrides.getVariableData: A function taking a single argument,
   *        the name of a variable. This should return an object with the following properties:
   *          - {String|undefined} value: The variable's value. Undefined if variable is
   *            not set.
   *          - {RegisteredPropertyResource|undefined} registeredProperty: The registered
   *            property data (syntax, initial value, inherits). Undefined if the variable
   *            is not a registered property.
   * @param {Boolean} overrides.isDarkColorScheme: Is the currently applied color scheme dark.
   * @return {Object} Overridden options object
   */
  #mergeOptions(overrides) {
    const defaults = {
      useDefaultColorUnit: true,
      defaultColorUnit: "authored",
      angleClass: null,
      angleSwatchClass: null,
      bezierClass: null,
      bezierSwatchClass: null,
      colorClass: null,
      colorSwatchClass: null,
      colorSwatchReadOnly: false,
      filterSwatch: false,
      flexClass: null,
      gridClass: null,
      shapeClass: null,
      shapeSwatchClass: null,
      supportsColor: false,
      urlClass: null,
      fontFamilyClass: null,
      baseURI: undefined,
      getVariableData: null,
      unmatchedClass: null,
      inStartingStyleRule: false,
      isDarkColorScheme: null,
    };

    for (const item in overrides) {
      defaults[item] = overrides[item];
    }
    return defaults;
  }
}

module.exports = OutputParser;
