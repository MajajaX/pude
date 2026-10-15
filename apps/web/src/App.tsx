import Nav from "./components/Nav";
import Hero from "./components/Hero";
import Manifesto from "./components/Manifesto";
import Showcase from "./components/Showcase";
import Features from "./components/Features";
import Architecture from "./components/Architecture";
import Compare from "./components/Compare";
import Languages from "./components/Languages";
import Philosophy from "./components/Philosophy";
import Shortcuts from "./components/Shortcuts";
import Footer from "./components/Footer";

export default function App() {
  return (
    <>
      <div class="site-bg" aria-hidden="true" />
      <Nav />
      <main>
        <Hero />
        <Manifesto />
        <Showcase />
        <Features />
        <Architecture />
        <Compare />
        <Languages />
        <Philosophy />
        <Shortcuts />
      </main>
      <Footer />
    </>
  );
}
