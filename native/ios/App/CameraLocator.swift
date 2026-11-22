import AVFoundation
import StacksShellCore
import UIKit
import Vision

/// `camera.locate` (native/protocol/v1.json): a full-screen camera view that looks for the page's QR
/// codes and answers with the direction of each from the phone once they all hold steady. The page
/// never gets a frame: only `CameraKit.result`'s rays and the motion attitude.
@MainActor
final class CameraLocator: UIViewController {
    typealias Attitude = (roll: Double, pitch: Double, yaw: Double)

    private let locate: CameraKit.Locate
    private let attitude: () -> Attitude?
    private var continuation: CheckedContinuation<JSONValue, Error>?
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "ninja.dashnash.stacks.camera")
    private var hold: CameraKit.Hold
    private var fovLong = 1.2
    private var aspect = 0.5625
    private var analyzer: FrameAnalyzer?
    private var timeout: Task<Void, Never>?
    private let status = UILabel()
    private let prompt = UILabel()

    private init(_ locate: CameraKit.Locate, attitude: @escaping () -> Attitude?) {
        self.locate = locate
        self.attitude = attitude
        self.hold = CameraKit.Hold(codes: locate.codes, holdMs: locate.holdMs)
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    /// Asks for the camera if it hasn't yet, shows the view on `presenter` and waits for the answer.
    static func run(_ locate: CameraKit.Locate, on presenter: UIViewController, attitude: @escaping () -> Attitude?, started: (CameraLocator) -> Void) async throws -> JSONValue {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .video) else { throw BridgeError(.forbidden, "Camera access was turned down") }
        default:
            throw BridgeError(.forbidden, "Camera access is off for DashyHQ: turn it on in Settings")
        }
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw BridgeError(.unsupported, "This device has no back camera")
        }
        let locator = CameraLocator(locate, attitude: attitude)
        try locator.configure(device)
        started(locator)
        return try await withCheckedThrowingContinuation { c in
            locator.continuation = c
            presenter.present(locator, animated: true)
            locator.begin()
        }
    }

    /// The page went away or asked again: stop and answer `cancelled`.
    func cancel(_ message: String = "Cancelled") {
        finish(.failure(BridgeError(.cancelled, message)))
    }

    private func configure(_ device: AVCaptureDevice) throws {
        session.beginConfiguration()
        session.sessionPreset = .hd1920x1080
        do {
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else { throw BridgeError(.failed, "The camera is busy") }
            session.addInput(input)
        } catch let e as BridgeError {
            session.commitConfiguration()
            throw e
        } catch {
            session.commitConfiguration()
            throw BridgeError(.failed, "Couldn't open the camera: \(error.localizedDescription)")
        }
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        let analyzer = FrameAnalyzer(codes: Set(locate.codes)) { [weak self] t, frame in
            Task { @MainActor in self?.frame(t: t, frame) }
        }
        self.analyzer = analyzer
        output.setSampleBufferDelegate(analyzer, queue: queue)
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            throw BridgeError(.failed, "The camera is busy")
        }
        session.addOutput(output)
        // Stabilisation crops and shifts the image: the rays need the lens's own geometry.
        if let connection = output.connection(with: .video), connection.isVideoStabilizationSupported {
            connection.preferredVideoStabilizationMode = .off
        }
        session.commitConfiguration()
        try? device.lockForConfiguration()
        device.videoZoomFactor = 1
        device.unlockForConfiguration()
        fovLong = Double(device.activeFormat.videoFieldOfView) * .pi / 180
        let size = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        if size.width > 0, size.height > 0 {
            aspect = Double(min(size.width, size.height)) / Double(max(size.width, size.height))
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let preview = PreviewView(session: session)
        preview.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(preview)

        prompt.text = locate.prompt ?? "Point the back of your phone at the screen"
        status.text = "0 of \(locate.codes.count) found"
        for label in [prompt, status] {
            label.textColor = .white
            label.textAlignment = .center
            label.numberOfLines = 0
            label.font = .preferredFont(forTextStyle: label === prompt ? .headline : .body)
            label.adjustsFontForContentSizeCategory = true
            label.translatesAutoresizingMaskIntoConstraints = false
            label.shadowColor = .black
            label.shadowOffset = CGSize(width: 0, height: 1)
            view.addSubview(label)
        }
        let cancel = UIButton(type: .system, primaryAction: UIAction(title: "Cancel") { [weak self] _ in self?.cancel() })
        cancel.configuration = .filled()
        cancel.configuration?.baseBackgroundColor = .black.withAlphaComponent(0.6)
        cancel.configuration?.baseForegroundColor = .white
        cancel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cancel)

        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            preview.topAnchor.constraint(equalTo: view.topAnchor),
            preview.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            preview.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            preview.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            prompt.topAnchor.constraint(equalTo: safe.topAnchor, constant: 16),
            prompt.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 20),
            prompt.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -20),
            status.bottomAnchor.constraint(equalTo: cancel.topAnchor, constant: -16),
            status.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 20),
            status.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -20),
            cancel.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -16),
            cancel.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
            cancel.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])
    }

    private func begin() {
        let session = session
        queue.async { session.startRunning() }
        let ms = locate.timeoutMs
        timeout = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
            guard !Task.isCancelled else { return }
            self?.finish(.failure(BridgeError(.failed, "Couldn't find the screen in time")))
        }
    }

    private func frame(t: Double, _ frame: [String: CameraKit.Sighting]) {
        guard continuation != nil else { return }
        let seen = hold.seen(frame)
        let done = hold.add(t: t, frame)
        status.text = seen == locate.codes.count ? "\(seen) of \(locate.codes.count) found · hold still" : "\(seen) of \(locate.codes.count) found"
        guard done else { return }
        guard let a = attitude() else {
            return finish(.failure(BridgeError(.failed, "Start motion before camera.locate")))
        }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        finish(.success(CameraKit.result(hold.last, fovLong: fovLong, aspect: aspect, attitude: a)))
    }

    private func finish(_ result: Result<JSONValue, Error>) {
        guard let c = continuation else { return }
        continuation = nil
        timeout?.cancel()
        let session = session
        queue.async { session.stopRunning() }
        presentingViewController?.dismiss(animated: true)
        c.resume(with: result)
    }
}

/// Runs Vision's QR detector on each frame (on the camera's queue) and reports the page's codes.
private final class FrameAnalyzer: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let codes: Set<String>
    private let report: @Sendable (Double, [String: CameraKit.Sighting]) -> Void

    init(codes: Set<String>, report: @escaping @Sendable (Double, [String: CameraKit.Sighting]) -> Void) {
        self.codes = codes
        self.report = report
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let request = VNDetectBarcodesRequest()
        request.symbologies = [.qr]
        // The buffer is the sensor's landscape image; `.right` makes Vision's coordinates those of
        // the phone held upright (u to the right edge, v to the top edge), which `CameraKit.ray` expects.
        let handler = VNImageRequestHandler(cmSampleBuffer: sampleBuffer, orientation: .right, options: [:])
        guard (try? handler.perform([request])) != nil else { return }
        var frame: [String: CameraKit.Sighting] = [:]
        for o in request.results ?? [] {
            guard let code = o.payloadStringValue, codes.contains(code) else { continue }
            let corners = [o.topLeft, o.topRight, o.bottomRight, o.bottomLeft].map { CameraKit.ImagePoint(u: Double($0.x), v: Double($0.y)) }
            let centre = CameraKit.ImagePoint(u: corners.map(\.u).reduce(0, +) / 4, v: corners.map(\.v).reduce(0, +) / 4)
            frame[code] = CameraKit.Sighting(centre: centre, corners: corners)
        }
        report(CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds, frame)
    }
}

/// The camera's live picture, upright.
private final class PreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

    init(session: AVCaptureSession) {
        super.init(frame: .zero)
        let preview = self.layer as! AVCaptureVideoPreviewLayer
        preview.session = session
        preview.videoGravity = .resizeAspectFill
        if let connection = preview.connection, connection.isVideoRotationAngleSupported(90) {
            connection.videoRotationAngle = 90
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }
}
