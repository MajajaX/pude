import { hydrate, render } from "solid-js/web";
import DocsApp from "./components/DocsApp";
import { applySavedLocale } from "./i18n-runtime";
import "./styles.css";

const root = document.getElementById("root")!;
if (root.hasChildNodes()) hydrate(() => <DocsApp />, root);
else render(() => <DocsApp />, root);
applySavedLocale();
