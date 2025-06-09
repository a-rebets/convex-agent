import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import { IdeaDetail } from "./pages/IdeaDetail";
import { Toaster } from "./components/ui/toaster";
import ChatBasic from "@example/chat-basic/src/ChatBasic";
import ChatStreaming from "@example/chat-streaming/src/ChatStreaming";
import { Index } from "./pages/Index";
import { WeatherFashion } from "./pages/WeatherFashion";
import { Images } from "./pages/Images";
import FilesImages from "@example/files-images/src/FilesImages";
export default function App() {
  return (
    <BrowserRouter>
      <div className="h-screen flex flex-col">
        <header className="z-50 bg-white/80 backdrop-blur-sm p-4 flex justify-between items-center border-b">
          <nav className="flex gap-4 items-center">
            <Link to="/" className="hover:text-indigo-600">
              <h2 className="text-xl font-semibold accent-text">
                Agent Examples
              </h2>
            </Link>
          </nav>
        </header>
        <main className="flex-1 h-full overflow-scroll">
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/weather-fashion" element={<WeatherFashion />} />
            <Route path="/chat-basic" element={<ChatBasic />} />
            <Route path="/chat-streaming" element={<ChatStreaming />} />
            <Route path="/files-images" element={<FilesImages />} />
            <Route path="/ideas/:id" element={<IdeaDetail />} />
            <Route path="/images" element={<Images />} />
          </Routes>
        </main>
        <Toaster />
      </div>
    </BrowserRouter>
  );
}
