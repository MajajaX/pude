import { hydrate, render } from "solid-js/web";
import DocsApp from "./components/DocsApp";
import "./styles.css";

const root = document.getElementById("root")!;
if (root.hasChildNodes()) hydrate(() => <DocsApp />, root);
else render(() => <DocsApp />, root);
