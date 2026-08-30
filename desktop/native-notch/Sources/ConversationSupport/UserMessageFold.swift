// "IS THIS MESSAGE TOO LONG TO SHOW WHOLE?" — asked of a measurement, with a
// dead zone, for the same reason BottomProximity is.
//
// A dictated paragraph can run twenty lines. Rendered in full it pushes the
// answer off the screen, so the thread becomes a wall of your own words with
// the reply somewhere below the fold. Capping it and fading the last inch says
// "there is more here" and gives it back on a tap.
//
// WHY THIS CANNOT BECOME THE FREEZE. The rule in BottomProximity generalises:
// any state that both READS layout and CHANGES layout needs a dead zone wider
// than its own effect. Both halves are handled here:
//
//   1. The height fed in comes from a hidden copy of the text that ALWAYS
//      renders in full. Folding the visible bubble cannot change it, so the
//      input is a constant with respect to the decision it drives. That alone
//      closes the loop.
//   2. The slack below is still wider than the fade the decision draws, so
//      even a measurement that did move could not cross back over the line.

import CoreGraphics

/// How tall a user's own message may be before it is folded. Roughly nine
/// lines at the 14pt/22pt the bubble uses — enough to read a normal request
/// whole, short enough that a long one cannot bury the answer under it.
public let userBubbleMaxHeight: CGFloat = 200

/// Height of the gradient that signals there is more underneath.
public let userBubbleFadeHeight: CGFloat = 44

/// Fold only when there is enough below the cap to be worth a tap. Folding a
/// message that would have fitted in one more line hides almost nothing and
/// costs the reader an interaction to get it back.
public let userBubbleFoldSlack: CGFloat = 56

/// Should this message be folded?
///
/// - Parameter fullHeight: the unclipped height of the text. Non-finite or
///   non-positive means NOT MEASURED YET — answer no, because folding on a
///   height we do not have would flash a collapsed bubble at every reader
///   before the real one arrives.
public func userTextOverflows(
    fullHeight: CGFloat,
    cap: CGFloat = userBubbleMaxHeight,
    slack: CGFloat = userBubbleFoldSlack,
) -> Bool {
    guard fullHeight.isFinite, fullHeight > 0 else { return false }
    return fullHeight > cap + slack
}
