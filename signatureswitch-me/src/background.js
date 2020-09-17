const xmlSerializer = new XMLSerializer();
const domParser = new DOMParser();

const PLAINTEXT_SIGNATURE_SEPARATOR = "-- \n";
const HTML_SIGNATURE_CLASS = "moz-signature";
const WINDOW_TYPE_MESSAGE_COMPOSE = "messageCompose";

let composeActionTabId;
let foundSignatureId;

/* =====================================================================================================================
   init ...
 */

(() => {
    createContextMenu();

    addContextMenuListener();
    addStorageChangeListener();
    addCommandListener();
    addMessageListener();
    addBrowserActionListener();
    addComposeActionListener();
    addWindowCreateListener();
})();

/* =====================================================================================================================
   context-menu ...
 */

function createContextMenu() {
    const ROOT_MENU = "signature_switch";

    browser.menus.remove(ROOT_MENU);

    browser.storage.local.get().then(localStorage => {
        const SUB_MENU_PREFIX = ROOT_MENU + "_";
        const menuItems = [];

        menuItems.push({
            id: ROOT_MENU,
            title: browser.i18n.getMessage("extensionName"),
            contexts: [
                // TODO
                // the MailExtension-API lacks a suitable context-type for the composer-window;
                // so this won't work atm
                "editable"
            ]
        });

        menuItems.push({
            id: SUB_MENU_PREFIX + "on-off",
            parentId: ROOT_MENU,
            title: "ON/OFF"
        });

        menuItems.push({
            parentId: ROOT_MENU,
            type: "separator"
        });

        if (localStorage.signatures) {
            localStorage.signatures.forEach(signature => {
                menuItems.push({
                    id: SUB_MENU_PREFIX + signature.id,
                    title: truncateString(signature.name, 20),
                    parentId: ROOT_MENU
                });
            });

            menuItems.push({
                parentId: ROOT_MENU,
                type: "separator"
            });

            menuItems.push({
                parentId: ROOT_MENU,
                title: "Options"
            });

            createMenuItems(menuItems);
        }
    });
}

function createMenuItems(items) {
    if (typeof items !== "undefined" && items.length > 0) {
        browser.menus.create(items.pop(), createMenuItems(items));
    }
}

/* =====================================================================================================================
   listeners ...
 */

function addContextMenuListener() {
    browser.menus.onClicked.addListener(async (info, tab) => {
        let commandOrSignatureId = info.menuItemId.startsWith("signature_switch_") ? info.menuItemId.substring(info.menuItemId.lastIndexOf("_" + 1)) : undefined;

        switch (info.menuItemId) {
            case "on-off":
                await searchSignatureInComposer(tab.id);
                if (foundSignatureId === "") {
                    appendDefaultSignatureToComposer(tab.id);
                } else {
                    removeSignatureFromComposer(tab.id);
                }
                break;
            default:
                appendSignatureViaIdToComposer(commandOrSignatureId, tab.id);
                break;
        }
    });
}

function addStorageChangeListener() {
    browser.storage.onChanged.addListener(changes => {
        createContextMenu();

        let changedItems = Object.keys(changes);

        for (let item of changedItems) {
            // TODO
            if (item === "???") {
            }
        }
    });
}

function addCommandListener() {
    browser.commands.onCommand.addListener(name => {
        browser.windows.getAll().then(windows => {
            for (let window of windows) {
                if (window.type === WINDOW_TYPE_MESSAGE_COMPOSE && window.focused === true) {
                    browser.tabs.query({windowId: window.id}).then(async tabs => {
                        let mailTabId = tabs[0].id;

                        await searchSignatureInComposer(mailTabId);

                        switch (name) {
                            case "switch":
                                if (foundSignatureId === "") {
                                    appendDefaultSignatureToComposer(mailTabId);
                                } else {
                                    removeSignatureFromComposer(mailTabId);
                                }
                                break;
                            case "next":
                            case "previous":
                                if (foundSignatureId === "") {
                                    appendDefaultSignatureToComposer(mailTabId);
                                } else {
                                    let signatureIds = await getAllSignatureIds();
                                    let signatureIndex = signatureIds.indexOf(foundSignatureId);
                                    if (signatureIndex !== -1) {
                                        let newSignatureIndex;
                                        if (name === "next") {
                                            newSignatureIndex = signatureIndex === (signatureIds.length - 1) ? 0 : signatureIndex + 1;
                                        } else {
                                            newSignatureIndex = signatureIndex === 0 ? signatureIds.length - 1 : signatureIndex - 1;
                                        }

                                        appendSignatureViaIdToComposer(signatureIds[newSignatureIndex], mailTabId);
                                    }
                                }
                                break;
                        }
                    });
                    break;
                }
            }
        });
    });
}

function addMessageListener() {
    browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
        switch (request.type) {
            case "switchSignature":
                if (request.value === "on") {
                    appendDefaultSignatureToComposer();
                } else {
                    removeSignatureFromComposer();
                }
                break;
            case "insertSignature":
                appendSignatureViaIdToComposer(request.value);
                break;
            case "isSignaturePresent":
                sendResponse({result: foundSignatureId !== ""});
                break;
            default:
                console.log("invalid message type!");
        }
    });
}

function addBrowserActionListener() {
    browser.browserAction.onClicked.addListener(() => {
        browser.tabs.create({url: "/options/page.html"});
    });
}

function addComposeActionListener() {
    browser.composeAction.onClicked.addListener(tab => {
        composeActionTabId = tab.id;

        searchSignatureInComposer();

        // "dirty hack" ;-)
        // (this way we can have both a popup(script) and the click-event in here)
        browser.composeAction.setPopup({popup: "compose/popup.html"});
        browser.composeAction.openPopup();
        browser.composeAction.setPopup({popup: ""});
    });
}

function addWindowCreateListener() {
    browser.windows.onCreated.addListener(window => {
        browser.storage.local.get().then(localStorage => {
            if (localStorage.defaultAction) {
                if (window.type === WINDOW_TYPE_MESSAGE_COMPOSE) {
                    browser.tabs.query({windowId: window.id}).then(tabs => {
                        if (localStorage.defaultAction === "insert") {
                            appendDefaultSignatureToComposer(tabs[0].id);
                        } else {
                            removeSignatureFromComposer(tabs[0].id);
                        }
                    });
                }
            }
        });
    });
}

/* =====================================================================================================================
   composer interaction ...
 */

async function appendSignatureToComposer(signature, tabId = composeActionTabId) {
    let details = await browser.compose.getComposeDetails(tabId);
    let cleansedBody = getBodyWithoutSignature(details);

    if (details.isPlainText) {
        cleansedBody += createPlainTextSignature(signature.text);
        browser.compose.setComposeDetails(tabId, {plainTextBody: cleansedBody});
    } else {
        let document = domParser.parseFromString(cleansedBody, "text/html");
        let renderedSignature;
        if (signature.html !== "") {
            renderedSignature = createHtmlSignature(document, signature.html);
        } else {
            // fallback to plaintext-signature content
            renderedSignature = createHtmlSignature(document, signature.text, "pre");
        }

        document.body.appendChild(renderedSignature);

        browser.compose.setComposeDetails(tabId, {body: xmlSerializer.serializeToString(document)});
    }
}

async function appendDefaultSignatureToComposer(tabId = composeActionTabId) {
    browser.storage.local.get().then(localStorage => {
        if (localStorage.signatures && localStorage.defaultSignature) {
            let signatures = localStorage.signatures;
            for (let signature of signatures) {
                if (signature.id === localStorage.defaultSignature) {
                    appendSignatureToComposer(signature, tabId);
                    break;
                }
            }
        }
    });
}

async function appendSignatureViaIdToComposer(signatureId, tabId = composeActionTabId) {
    browser.storage.local.get().then(localStorage => {
        if (localStorage.signatures) {
            let signatures = localStorage.signatures;
            for (let signature of signatures) {
                if (signature.id === signatureId) {
                    appendSignatureToComposer(signature, tabId);
                    break;
                }
            }
        }
    });
}

async function removeSignatureFromComposer(tabId = composeActionTabId) {
    browser.compose.getComposeDetails(tabId).then(details => {
        let newDetails = details.isPlainText ? {plainTextBody: getBodyWithoutSignature(details)} : {body: getBodyWithoutSignature(details)};
        browser.compose.setComposeDetails(tabId, newDetails);
    });
}

async function searchSignatureInComposer(tabId = composeActionTabId) {
    foundSignatureId = "";

    let localStorage = await browser.storage.local.get();

    if (localStorage.signatures) {
        let signatures = localStorage.signatures;
        let details = await browser.compose.getComposeDetails(tabId);
        let bodyDocument = details.isPlainText ? undefined : domParser.parseFromString(details.body, "text/html");

        for (let signature of signatures) {
            if (details.isPlainText) {
                if (details.plainTextBody.endsWith(createPlainTextSignature(signature.text))) {
                    foundSignatureId = signature.id;
                    break;
                }
            } else {
                let htmlSignatures = bodyDocument.getElementsByClassName(HTML_SIGNATURE_CLASS);

                if (htmlSignatures && htmlSignatures.length > 0) {
                    let lastHtmlSignature = htmlSignatures[htmlSignatures.length - 1];
                    let signatureFound = (signature.html === "") ? (lastHtmlSignature.textContent === signature.text) : (lastHtmlSignature.innerHTML === signature.html);
                    if (signatureFound) {
                        foundSignatureId = signature.id;
                        break;
                    }
                }
            }
        }
    }
}

/* =====================================================================================================================
   signature creation ...
 */

function createPlainTextSignature(text) {
    return "\n" + PLAINTEXT_SIGNATURE_SEPARATOR + text;
}

function createHtmlSignature(document, html, elementType = "div") {
    let element = document.createElement(elementType);
    element.innerHTML = html;
    element.className = HTML_SIGNATURE_CLASS;
    element.setAttribute("cols", "72");

    return element;
}

/* =====================================================================================================================
   helpers ...
 */

function getBodyWithoutSignature(composeDetails) {
    if (composeDetails.isPlainText) {
        let body = composeDetails.plainTextBody;
        let signatureIndex = body.lastIndexOf("\n" + PLAINTEXT_SIGNATURE_SEPARATOR);

        return signatureIndex > -1 ? body.substring(0, body.lastIndexOf("\n" + PLAINTEXT_SIGNATURE_SEPARATOR)) : body;
    } else {
        let document = domParser.parseFromString(composeDetails.body, "text/html");
        let signatures = document.getElementsByClassName(HTML_SIGNATURE_CLASS);

        if (signatures && signatures.length > 0) {
            signatures[signatures.length - 1].remove();
            return xmlSerializer.serializeToString(document);
        } else {
            return composeDetails.body;
        }
    }
}

function truncateString(string, length) {
    if (string.length <= length) {
        return string;
    }

    return string.slice(0, length) + "...";
}

async function getAllSignatureIds() {
    let ids = [];

    await browser.storage.local.get().then(localStorage => {
        if (localStorage.signatures) {
            localStorage.signatures.forEach(signature => {
                ids.push(signature.id);
            });
        }
    });

    return ids;
}
