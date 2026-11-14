import { Benchmarks } from './components/Benchmarks';
import { Footer } from './components/Footer';
import { Hero } from './components/Hero';
import { HostMatrix } from './components/HostMatrix';
import { LiveDemo } from './components/LiveDemo';
import { Nav } from './components/Nav';
import { Usage } from './components/Usage';

export default function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Usage />
        <LiveDemo />
        <HostMatrix />
        <Benchmarks />
      </main>
      <Footer />
    </>
  );
}
