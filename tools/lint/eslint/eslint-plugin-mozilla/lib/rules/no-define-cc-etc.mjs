/**
 * @file Reject defining Cc/Ci/Cr/Cu.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const componentsList = ["Cc", "Ci", "Cr", "Cu"];

export default {
  meta: {
    docs: {
      url: "https://firefox-source-docs.mozilla.org/code-quality/lint/linters/eslint-plugin-mozilla/rules/no-define-cc-etc.html",
    },
    messages: {
      noSeparateDefinition:
        "{{name}} is now defined in global scope, a separate definition is no longer necessary.",
    },
    schema: [],
    type: "suggestion",
  },

  create(context) {
    return {
      VariableDeclarator(node) {
        if (
          node.id.type == "Identifier" &&
          componentsList.includes(node.id.name)
        ) {
          context.report({
            node,
            messageId: "noSeparateDefinition",
            data: { name: node.id.name },
          });
        }

        if (node.id.type == "ObjectPattern") {
          for (let property of node.id.properties) {
            if (
              property.type == "Property" &&
              componentsList.includes(property.value.name)
            ) {
              context.report({
                node,
                messageId: "noSeparateDefinition",
                data: { name: property.value.name },
              });
            }
          }
        }
      },
    };
  },
};
